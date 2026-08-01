package chat.reaper.socket

import android.util.Base64
import com.getcapacitor.JSObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * TCP for the WebView, on Android.
 *
 * The counterpart to iOS's `TcpSockets.swift`, which uses `Network.framework`
 * for two reasons that do not apply here: surviving a Wi-Fi/cellular handoff,
 * and staying alive in the background. A plain `java.net.Socket` held by a
 * foreground service (see the keepalive plugin) already survives
 * backgrounding — Android's suspension model only kills a process, not a
 * socket a running service holds — so there is no framework-managed
 * connection type to reach for; blocking sockets on background coroutines are
 * enough. Wi-Fi/cellular handoff is not specially handled either: a dead
 * connection surfaces as a read/write `IOException` the same as any other
 * failure, and the JS side already retries through the outbox mechanism.
 *
 * Sockets are addressed by id rather than handed across as objects, because
 * only JSON crosses the bridge. Payloads are base64 for the same reason.
 */
class TcpSockets(private val emit: (id: String, event: String, payload: JSObject) -> Unit) {

    /** A socket plus the lock that keeps two overlapping `send()`s from interleaving. */
    private class Conn(val socket: Socket) {
        val writeLock = Any()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val connections = ConcurrentHashMap<String, Conn>()

    /**
     * Every listener, by the port it ended up bound to.
     *
     * This device runs two onion services — the account address, forwarding
     * to the chat transport, and the sync address, forwarding to the pairing
     * service — and both have to stay bound at once. Keyed by port, not by a
     * caller-supplied id, because the port is what Tor is configured with and
     * therefore the only thing an inbound connection can be attributed to.
     */
    private val listeners = ConcurrentHashMap<Int, ServerSocket>()

    /**
     * The order listeners were bound in, which is what makes a WebView reload
     * recoverable. Tor does not reload — it goes on forwarding both onion
     * services to the ports it was told about at launch — so the fresh page
     * has to re-attach to the listeners already here (`listeningPorts()`)
     * rather than bind two new ones nothing forwards to.
     */
    private val order = CopyOnWriteArrayList<Int>()

    // ---- outbound --------------------------------------------------------

    /**
     * Open a connection through the local SOCKS5 proxy.
     *
     * `host` is an onion address. It is never resolved here — that is the
     * entire point of routing through Tor, and a DNS lookup for it would both
     * fail and tell the local resolver who is being contacted.
     */
    fun connect(id: String, host: String, port: Int, proxyPort: Int) {
        scope.launch {
            val socket = Socket()
            val conn = Conn(socket)
            connections[id] = conn

            try {
                // Small frames matter immediately here — a keystroke
                // indicator, a call answer — so Nagle's algorithm, which
                // would hold them back to combine with whatever comes next,
                // is switched off.
                socket.tcpNoDelay = true
                socket.keepAlive = true
                // Loopback to the embedded proxy: near-instant when it
                // succeeds, and bounded so a proxy that never came up fails
                // fast rather than hanging a coroutine forever.
                socket.connect(InetSocketAddress("127.0.0.1", proxyPort), 10_000)
                socks5Connect(conn, host, port)
            } catch (e: Exception) {
                if (connections.containsKey(id)) {
                    emit(id, "error", JSObject().put("message", describeError(e)))
                }
                close(id)
                return@launch
            }

            // Connected to the proxy *and* through the handshake to the
            // peer. Only now is the socket usable.
            emit(id, "connect", JSObject())
            readLoop(id, conn)
        }
    }

    // ---- inbound -----------------------------------------------------------

    /**
     * Bind a loopback port and report which one was granted.
     *
     * Bound to loopback only. An onion service is reached by Tor forwarding
     * to a local port, so nothing outside this device should ever be able to
     * open this — binding every interface would put an unauthenticated
     * Reaper transport on the local Wi-Fi.
     */
    fun listen(port: Int, then: (Result<Int>) -> Unit) {
        // A specific port asked for twice is the same listener asked for
        // twice — callers on the JS side are idempotent and may ask more
        // than once. Only an exact repeat is treated that way; asking for
        // zero always binds something new.
        if (port != 0 && listeners.containsKey(port)) {
            then(Result.success(port))
            return
        }

        scope.launch {
            val server: ServerSocket
            try {
                server = ServerSocket()
                server.reuseAddress = true
                server.bind(InetSocketAddress("127.0.0.1", port))
            } catch (e: IOException) {
                then(Result.failure(e))
                return@launch
            }

            val bound = server.localPort
            // Recorded under the port it actually got, which for a request
            // of zero is not known until the bind completes.
            listeners[bound] = server
            if (!order.contains(bound)) order.add(bound)

            then(Result.success(bound))
            acceptLoop(bound, server)
        }
    }

    private fun acceptLoop(boundPort: Int, server: ServerSocket) {
        while (!server.isClosed) {
            val socket = try {
                server.accept()
            } catch (e: IOException) {
                // Normal on close(): accept() unblocks with an exception the
                // instant the listening socket is closed elsewhere.
                break
            }

            val id = "in-" + UUID.randomUUID().toString()
            val conn = Conn(socket)
            connections[id] = conn
            try {
                socket.tcpNoDelay = true
            } catch (e: IOException) {
                // Best-effort; the connection is still usable without it.
            }

            // Which local port this arrived on, so the JS side can hand it to
            // the right server. Two onion services forward to two ports and
            // they speak different protocols — a connection given to the
            // wrong one reads as a corrupt length prefix, not a routing bug.
            emit(id, "accept", JSObject().put("port", boundPort))
            scope.launch { readLoop(id, conn) }
        }
    }

    /** Stop one listener, or every one of them. */
    fun stopListening(port: Int) {
        if (port == 0) {
            listeners.values.forEach { safeClose(it) }
            listeners.clear()
            order.clear()
            return
        }

        listeners.remove(port)?.let { safeClose(it) }
        order.remove(port)
    }

    /**
     * The ports currently bound, oldest first.
     *
     * Read by the JS side after a reload so it can re-attach to the listeners
     * Tor is still forwarding to, instead of binding two new ports nothing
     * points at.
     */
    fun listeningPorts(): List<Int> = order.filter { listeners.containsKey(it) }

    // ---- moving bytes ------------------------------------------------------

    fun send(id: String, data: ByteArray) {
        val conn = connections[id] ?: return
        scope.launch {
            try {
                synchronized(conn.writeLock) {
                    conn.socket.getOutputStream().write(data)
                    conn.socket.getOutputStream().flush()
                }
            } catch (e: IOException) {
                emit(id, "error", JSObject().put("message", describeError(e)))
                close(id)
            }
        }
    }

    /**
     * Read forever, handing each chunk up as it arrives.
     *
     * No framing here. The transport already length-prefixes its own frames
     * and copes with a chunk that is half a frame or three of them, because
     * that is what TCP does — reimplementing that boundary logic here would
     * be a second copy of it to keep in step.
     */
    private fun readLoop(id: String, conn: Conn) {
        val input = conn.socket.getInputStream()
        val buf = ByteArray(64 * 1024)

        try {
            while (true) {
                val n = input.read(buf)
                if (n == -1) {
                    close(id)
                    return
                }
                if (n > 0) {
                    val chunk = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                    emit(id, "data", JSObject().put("data", chunk))
                }
            }
        } catch (e: IOException) {
            if (connections.containsKey(id)) {
                emit(id, "error", JSObject().put("message", describeError(e)))
            }
            close(id)
        }
    }

    /** Idempotent: a second call on an id already gone is a silent no-op. */
    fun close(id: String) {
        val conn = connections.remove(id) ?: return
        safeClose(conn.socket)
        emit(id, "close", JSObject())
    }

    fun closeAll() {
        connections.keys.toList().forEach { close(it) }
        stopListening(0)
    }

    // ---- SOCKS5 --------------------------------------------------------------
    //
    // RFC 1928, the subset Tor implements and this needs:
    //
    //   greeting   05 01 00                  version, one method, "no auth"
    //   choice     05 00                      version, method accepted
    //   request    05 01 00 03 len host port  connect, by domain name
    //   reply      05 00 00 ...               version, success, bound address
    //
    // The domain-name address type is the important one: it hands the onion
    // address to Tor as a name and lets Tor do the resolving, which is what
    // keeps the destination off this device's DNS.

    private fun socks5Connect(conn: Conn, host: String, port: Int) {
        val socket = conn.socket
        val input = socket.getInputStream()

        writeLocked(conn, byteArrayOf(0x05, 0x01, 0x00))
        val choice = readExact(input, 2)
        if (choice[0] != 0x05.toByte() || choice[1] != 0x00.toByte()) {
            throw IOException("proxy refused the connection")
        }

        val name = host.toByteArray(Charsets.UTF_8)
        if (name.size > 255) throw IOException("address too long")

        val request = ByteArrayOutputStream()
        request.write(byteArrayOf(0x05, 0x01, 0x00, 0x03, name.size.toByte()))
        request.write(name)
        request.write((port shr 8) and 0xff)
        request.write(port and 0xff)
        writeLocked(conn, request.toByteArray())

        // The reply header is four bytes plus a bound address whose length
        // depends on its type, so it is read in two parts rather than guessed.
        val head = readExact(input, 4)
        if (head[0] != 0x05.toByte()) throw IOException("bad proxy reply")
        if (head[1] != 0x00.toByte()) throw IOException(socksError(head[1]))

        val trailing = when (head[3].toInt() and 0xff) {
            0x01 -> 4 + 2   // IPv4 and port
            0x04 -> 16 + 2  // IPv6 and port
            0x03 -> -1      // length-prefixed name
            else -> throw IOException("unknown address type")
        }

        if (trailing >= 0) {
            readExact(input, trailing)
        } else {
            val length = readExact(input, 1)[0].toInt() and 0xff
            readExact(input, length + 2)
        }
    }

    private fun writeLocked(conn: Conn, bytes: ByteArray) {
        synchronized(conn.writeLock) {
            conn.socket.getOutputStream().write(bytes)
            conn.socket.getOutputStream().flush()
        }
    }

    /**
     * Read exactly this many bytes, or throw.
     *
     * Every field in the handshake is fixed-length, and reading one byte too
     * few would desynchronise everything after it — so this loops rather than
     * trusting a single `read()` to fill the buffer, which it is not obliged
     * to do.
     */
    private fun readExact(input: InputStream, n: Int): ByteArray {
        if (n == 0) return ByteArray(0)
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r == -1) throw IOException("proxy closed during handshake")
            off += r
        }
        return buf
    }

    private fun socksError(code: Byte): String = when (code.toInt() and 0xff) {
        0x01 -> "proxy failed"
        0x02 -> "not allowed"
        0x03 -> "network unreachable"
        0x04 -> "host unreachable — the onion service may be offline"
        0x05 -> "connection refused"
        0x06 -> "timed out"
        else -> "proxy error ${code.toInt() and 0xff}"
    }

    private fun describeError(e: Exception): String = e.message ?: e.toString()

    private fun safeClose(socket: Socket) {
        try { socket.close() } catch (e: IOException) { /* already closed */ }
    }

    private fun safeClose(server: ServerSocket) {
        try { server.close() } catch (e: IOException) { /* already closed */ }
    }
}
