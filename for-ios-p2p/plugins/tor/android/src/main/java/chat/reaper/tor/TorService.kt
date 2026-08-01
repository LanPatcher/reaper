package chat.reaper.tor

import android.content.Context
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * An embedded Tor client, and the onion service this device answers at.
 *
 * ## Why this looks like desktop's `tor.ts`, not iOS's `TorService.swift`
 *
 * iOS links `Tor.framework` in-process because iOS forbids exec'ing an
 * arbitrary binary. Android has no such restriction — a native library
 * shipped as `lib*.so` and placed in `nativeLibraryDir` is allowed to be
 * exec'd, which is exactly how Guardian Project's `tor-android` dependency
 * ships `libtor.so`, and exactly how Orbot runs it. So Android spawns the
 * real `tor` binary as a subprocess and drives it with a torrc file, the same
 * shape as the desktop build — no linked framework, no control-port
 * cookie-auth dance, no bootstrap-percent control connection (skipped for the
 * first pass; `boot.ts` already tolerates "starting" jumping straight to
 * "ready" — see its `bootstrapping` case, which is optional).
 *
 * ## Where the key lives
 *
 * The hidden service directory holds the private key that *is* the address.
 * It lives under `noBackupFilesDir` so Android's Auto Backup never copies it
 * off the device — a key restored onto a second device would leave two
 * devices publishing the same address, which tor resolves by one of them
 * winning arbitrarily.
 *
 * ## Surviving a WebView reload
 *
 * Capacitor rebuilds its plugins across a WebView reload (linking a device,
 * importing an identity), but the Android app *process* — and the tor
 * subprocess already running inside it — survives that. A freshly
 * constructed `TorService` must not launch a second tor, so the running
 * process and the addresses read off it are held at the companion-object
 * level, which outlives any individual instance the same way iOS's
 * process-global statics do.
 */
class TorService(
    private val context: Context,
    private val emit: (state: String, detail: JSObject) -> Unit,
) {
    companion object {
        private const val TAG = "TorService"

        /**
         * The loopback port tor's SOCKS proxy listens on.
         *
         * Fixed, not "auto" — there is no control connection here to ask tor
         * what it chose, so a chosen-at-random port could never be learned at
         * all. 39050 rather than the default 9050, so this does not collide
         * with a system Tor (Orbot) that might already be running on the
         * device.
         */
        private const val SOCKS_PORT = 39050

        /** The running tor process, if any — shared across every instance in this process. */
        @Volatile private var process: Process? = null

        /** What the launch that actually started tor decided. Frozen for the process's life. */
        @Volatile private var launchedWithAccount: Boolean? = null

        @Volatile private var lastOnion: String? = null
        @Volatile private var lastSyncOnion: String? = null

        private const val SECRET_FILE = "hs_ed25519_secret_key"
        private const val PUBLIC_FILE = "hs_ed25519_public_key"
        private const val HOSTNAME_FILE = "hostname"
        private const val SECRET_TAG = "== ed25519v1-secret: type0 =="
        private const val PUBLIC_TAG = "== ed25519v1-public: type0 =="

        private fun serviceDir(context: Context): File =
            File(File(context.noBackupFilesDir, "tor"), "service")

        /** tor's header: the tag in ASCII, zero-padded to 32 bytes. */
        private fun tag(text: String): ByteArray {
            val padded = ByteArray(32)
            val ascii = text.toByteArray(Charsets.US_ASCII)
            System.arraycopy(ascii, 0, padded, 0, ascii.size)
            return padded
        }

        /**
         * This device's service key, or empty strings if it has none yet.
         *
         * Absent is a normal answer rather than an error — tor may never have
         * been started on this device.
         */
        fun exportKey(context: Context): JSObject {
            val dir = serviceDir(context)
            val secretFile = File(dir, SECRET_FILE)
            val publicFile = File(dir, PUBLIC_FILE)

            if (!secretFile.exists() || !publicFile.exists()) {
                return JSObject().put("secret", "").put("public", "").put("hostname", "")
            }

            val hostnameFile = File(dir, HOSTNAME_FILE)
            val hostname = if (hostnameFile.exists()) hostnameFile.readText().trim() else ""

            return JSObject()
                .put("secret", Base64.encodeToString(secretFile.readBytes(), Base64.NO_WRAP))
                .put("public", Base64.encodeToString(publicFile.readBytes(), Base64.NO_WRAP))
                .put("hostname", hostname)
        }

        /**
         * Write a service key from a backup, and answer at that address from
         * now on (once tor is next started — see `TorPlugin.importKey`).
         */
        fun importKey(context: Context, secretB64: String, publicB64: String, hostname: String) {
            val secret = Base64.decode(secretB64, Base64.DEFAULT)
            val publicKey = Base64.decode(publicB64, Base64.DEFAULT)

            if (secret.size != 96 || !secret.copyOfRange(0, 32).contentEquals(tag(SECRET_TAG))) {
                throw IllegalArgumentException("the onion secret key is not in tor's format")
            }
            if (publicKey.size != 64 || !publicKey.copyOfRange(0, 32).contentEquals(tag(PUBLIC_TAG))) {
                throw IllegalArgumentException("the onion public key is not in tor's format")
            }

            val dir = serviceDir(context)
            ensureDir(dir)

            File(dir, SECRET_FILE).writeBytes(secret)
            File(dir, PUBLIC_FILE).writeBytes(publicKey)

            val address = hostname.trim().lowercase()
            val target = File(dir, HOSTNAME_FILE)
            if (address.endsWith(".onion") && address.length == 62) {
                target.writeText("$address\n")
            } else {
                // Stale, and worse than absent: it would be read back as this
                // device's address while tor published a different one.
                target.delete()
            }

            for (name in listOf(SECRET_FILE, PUBLIC_FILE, HOSTNAME_FILE)) {
                ownerOnly(File(dir, name))
            }
        }

        /** tor refuses to start against a hidden-service directory anyone else can read. */
        private fun ensureDir(dir: File) {
            if (!dir.exists()) dir.mkdirs()
            ownerOnly(dir)
        }

        private fun ownerOnly(file: File) {
            try {
                file.setReadable(false, false)
                file.setReadable(true, true)
                file.setWritable(false, false)
                file.setWritable(true, true)
                if (file.isDirectory) {
                    file.setExecutable(false, false)
                    file.setExecutable(true, true)
                }
            } catch (e: SecurityException) {
                // Best effort — Android's own per-app sandboxing already keeps
                // other apps out regardless of these bits.
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    var running: Boolean = false; private set
    var bootstrapped: Boolean = false; private set
    var onion: String? = null; private set
    var syncOnion: String? = null; private set
    var socksPort: Int = 0; private set
    var lastError: String? = null; private set

    /** Whether *this* launch configured the account service at all. */
    private var publishesAccount = true

    private fun dataDir(): File {
        val dir = File(context.noBackupFilesDir, "tor")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun serviceDirectory(): File {
        val dir = File(dataDir(), "service")
        ensureDir(dir)
        return dir
    }

    private fun syncDirectory(): File {
        val dir = File(dataDir(), "sync-service")
        ensureDir(dir)
        return dir
    }

    // ---- starting -----------------------------------------------------------

    /**
     * Start tor and publish an onion service pointing at `localPort`.
     *
     * Returns immediately — bootstrapping and publishing are reported as
     * events, not waited for, because either can take anywhere from seconds
     * to a couple of minutes.
     *
     * `account` decides whether the account address is published at all.
     * Exactly one device may answer at it, so a device another of the user's
     * devices has taken it from passes `false` and publishes only its sync
     * address. Unlike iOS, Android *could* restart tor to change this
     * mid-session — but nothing in the plugin contract asks it to, so this
     * only takes effect from a fresh launch, same as every other platform.
     */
    fun start(localPort: Int, syncPort: Int, account: Boolean) {
        val existing = process
        if (existing != null && existing.isAlive) {
            running = true
            bootstrapped = true
            socksPort = SOCKS_PORT
            publishesAccount = launchedWithAccount ?: account
            onion = lastOnion
            syncOnion = lastSyncOnion
            emit("ready", JSObject().put("socksPort", SOCKS_PORT))
            scope.launch { readOnionAddresses() }
            return
        }

        publishesAccount = account
        launchedWithAccount = account
        lastError = null

        scope.launch {
            try {
                val dir = dataDir()
                val serviceDirectory = serviceDirectory()
                val syncDirectory = syncDirectory()

                val logFile = File(dir, "tor.log")
                logFile.delete()
                val torrcFile = File(dir, "torrc")

                val effectiveSyncPort = if (syncPort > 0) syncPort else localPort

                val lines = mutableListOf(
                    "SocksPort $SOCKS_PORT",
                    "DataDirectory ${File(dir, "state").absolutePath}",
                )

                // ---- the account address, if this device is the one holding it --
                //
                // `HiddenServiceDir`/`HiddenServicePort`/`HiddenServiceVersion`
                // are an ordered unit: tor applies the port and version to
                // whichever directory line preceded them.
                if (account) {
                    lines += "HiddenServiceDir ${serviceDirectory.absolutePath}"
                    lines += "HiddenServicePort 80 127.0.0.1:$localPort"
                    lines += "HiddenServiceVersion 3"
                }

                // ---- the second service: this device's own sync address ---------
                //
                // Published unconditionally, including while this device is
                // displaced — a displaced device is the one that most needs
                // to be reachable, since that is how it finds out and takes
                // the account back.
                lines += "HiddenServiceDir ${syncDirectory.absolutePath}"
                lines += "HiddenServicePort 80 127.0.0.1:$effectiveSyncPort"
                lines += "HiddenServiceVersion 3"

                // Never a relay — the default already, stated so a phone
                // volunteering to carry other people's traffic is not a
                // surprising thing to discover by accident.
                lines += "ClientOnly 1"
                lines += "ExitRelay 0"

                // The only way to find out what tor is unhappy about: there
                // is no console here, and tor reports configuration problems
                // by writing a line and exiting. `SafeLogging` keeps
                // addresses out of the file.
                lines += "Log \"notice file ${logFile.absolutePath}\""
                lines += "SafeLogging 1"
                lines += "AvoidDiskWrites 1"

                torrcFile.writeText(lines.joinToString("\n"))

                val binary = File(context.applicationInfo.nativeLibraryDir, "libtor.so")
                if (!binary.exists()) {
                    fail(
                        "tor binary not found at ${binary.absolutePath} — " +
                            "the tor-android dependency may not have packaged it for this ABI",
                    )
                    return@launch
                }

                val builder = ProcessBuilder(binary.absolutePath, "-f", torrcFile.absolutePath)
                builder.directory(dir)
                builder.redirectErrorStream(true)

                val proc = try {
                    builder.start()
                } catch (e: IOException) {
                    fail("could not launch tor: ${e.message}")
                    return@launch
                }

                process = proc

                // tor's own log goes to the file above; this pipe should stay
                // near-empty, but draining it is what keeps a startup message
                // (or a native crash that bypasses tor's own logging) from
                // filling the pipe buffer and blocking the process.
                scope.launch {
                    try {
                        proc.inputStream.bufferedReader().forEachLine { Log.d(TAG, it) }
                    } catch (e: IOException) {
                        // process gone
                    }
                }

                scope.launch {
                    val code = proc.waitFor()
                    Log.i(TAG, "tor exited with code $code")
                    if (process === proc) {
                        process = null
                        running = false
                        bootstrapped = false
                        emit("stopped", JSObject())
                    }
                }

                running = true
                socksPort = SOCKS_PORT
                emit("starting", JSObject().put("socksPort", SOCKS_PORT))

                waitForSocks()

                bootstrapped = true
                emit("ready", JSObject().put("socksPort", SOCKS_PORT))

                readOnionAddresses()
            } catch (e: Exception) {
                fail("could not start tor: ${e.message}")
            }
        }
    }

    /**
     * Wait until tor's SOCKS port accepts a connection.
     *
     * Asked by opening one and dropping it, the same as desktop's
     * `waitForSocks` — a success here is the same act the next caller (the
     * socket plugin) is about to perform, so it is the only kind of evidence
     * that actually transfers.
     */
    private suspend fun waitForSocks(timeoutMs: Long = 30_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val open = try {
                Socket().use {
                    it.connect(InetSocketAddress("127.0.0.1", SOCKS_PORT), 1_000)
                    true
                }
            } catch (e: IOException) {
                false
            }
            if (open) return
            if (System.currentTimeMillis() > deadline) {
                throw IOException("tor did not open its SOCKS port on $SOCKS_PORT within ${timeoutMs}ms")
            }
            delay(250)
        }
    }

    /**
     * Poll for the published onion addresses.
     *
     * A displaced device (`publishesAccount == false`) reads the account
     * hostname once if it is already there — the address is the *account's*,
     * not the device's, and useful from any device on it — but does not poll
     * or fail on its absence, since no descriptor for it is coming from here.
     */
    private suspend fun readOnionAddresses() {
        val serviceDirectory = serviceDirectory()
        val syncDirectory = syncDirectory()

        if (!publishesAccount) {
            if (onion == null) {
                readHostnameOnce(serviceDirectory)?.let {
                    onion = it
                    lastOnion = it
                }
            }
            pollForSync(syncDirectory)
            return
        }

        // Publishing a descriptor takes a little while on a fresh service,
        // longer on a slow network. Thirty attempts at two seconds is a
        // minute.
        for (attempt in 0 until 30) {
            val address = readHostnameOnce(serviceDirectory)
            if (address != null) {
                onion = address
                lastOnion = address
                emit(
                    "published",
                    JSObject()
                        .put("onion", address)
                        .put("syncOnion", syncOnion)
                        .put("socksPort", socksPort),
                )
                pollForSync(syncDirectory)
                return
            }
            delay(2_000)
        }

        fail("the onion service did not publish — this device is reachable outbound only")
    }

    /**
     * Keep looking for the sync address after the account address has
     * arrived (or been skipped). The two services publish independently.
     */
    private suspend fun pollForSync(syncDirectory: File) {
        if (syncOnion != null) return

        for (attempt in 0 until 30) {
            val address = readHostnameOnce(syncDirectory)
            if (address != null) {
                syncOnion = address
                lastSyncOnion = address
                emit("sync", JSObject().put("syncOnion", address))
                return
            }
            delay(2_000)
        }
        // Given up quietly. A device with no sync address still works — it
        // simply has to be the one that dials rather than the one that answers.
    }

    private fun readHostnameOnce(dir: File): String? {
        val file = File(dir, "hostname")
        if (!file.exists()) return null
        val text = try {
            file.readText().trim()
        } catch (e: IOException) {
            return null
        }
        return text.ifEmpty { null }
    }

    // ---- stopping -------------------------------------------------------------

    fun stop() {
        process?.destroy()
        process = null
        launchedWithAccount = null
        lastOnion = null
        lastSyncOnion = null

        running = false
        bootstrapped = false
        socksPort = 0
        onion = null
        syncOnion = null

        emit("stopped", JSObject())
    }

    /**
     * Report a failure, with tor's own words attached — the only way to find
     * out what it actually objected to, since it reports configuration
     * problems by writing a line to its log and exiting.
     */
    private fun fail(message: String) {
        val tail = lastLogLines()
        val full = if (tail != null) "$message\n\ntor said:\n$tail" else message
        lastError = full
        running = false
        emit("failed", JSObject().put("error", full))
    }

    private fun lastLogLines(keep: Int = 12): String? {
        val file = File(dataDir(), "tor.log")
        if (!file.exists()) return null
        val lines = try {
            file.readLines()
        } catch (e: IOException) {
            return null
        }
        val tail = lines.filter { it.isNotBlank() }.takeLast(keep)
        return if (tail.isEmpty()) null else tail.joinToString("\n")
    }
}
