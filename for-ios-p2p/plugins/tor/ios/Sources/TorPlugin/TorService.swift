import Foundation
import Tor

/**
 * An embedded Tor client, and the onion service this device answers at.
 *
 * ## Why Tor has to be inside the app
 *
 * The desktop build runs the `tor` binary as a subprocess. iOS has no `fork`,
 * and shipping a separate executable is not permitted, so the only way to have
 * Tor on a phone is to link it in. `Tor.framework` is that: tor, libevent,
 * OpenSSL and liblzma compiled for iOS and driven through a control port.
 *
 * ## Two halves, and the second one is the hard one
 *
 * **Reaching out** is the easy half. Tor opens a SOCKS5 port on loopback and
 * `TcpSockets` dials through it — already written, already handling the
 * handshake, already passing onion addresses through as names so this device
 * never resolves them.
 *
 * **Being reachable** is the half that makes a peer-to-peer app possible at
 * all. A phone has no routable address and no port anybody can open; an onion
 * service is what gives it one. Tor publishes a descriptor to the directory
 * system, and a peer that knows the address gets a circuit built back to a
 * local port here. That is the entire reason this app can work without a
 * server, and it is configured below with `HiddenServiceDir` — which has to be
 * passed as an *argument* rather than an option, because tor reads the
 * directory and the port as an ordered pair.
 *
 * ## Where the key lives
 *
 * The hidden service directory holds the private key that *is* the address.
 * Lose it and the address changes and every peer's saved contact for this
 * device stops resolving; leak it and somebody else can impersonate the
 * address. It is written under Application Support with the file protection
 * that keeps it unreadable while the device is locked, and excluded from
 * iCloud backup — a key that syncs to a second device is a key two devices
 * would both try to publish from.
 */
/**
 * The loopback port tor's SOCKS proxy listens on.
 *
 * Fixed, not `auto`, and that is the whole point.
 *
 * With `auto` the port is chosen by tor and can only be learned by asking the
 * control connection, which answers exactly once — from inside an observer
 * that fires on the transition to "circuit established". Anything that misses
 * that moment never learns the port at all, and every outbound connection then
 * fails for the life of the process against a Tor client that is perfectly
 * healthy. Reloading the WebView is enough to miss it: Capacitor rebuilds its
 * plugins, the new `TorService` starts with `socksPort = 0`, and the tor
 * thread it would have asked is already running and not about to announce
 * itself again.
 *
 * A number that is decided in advance cannot be missed. It is known before tor
 * is even launched, survives the object being rebuilt, and needs no control
 * connection, no observer and no event. If something else on the device holds
 * it, tor says so in its log and refuses to start, which is a loud failure
 * rather than a silent one.
 */
private let SOCKS_PORT: UInt16 = 39050

/**
 * Whether tor is already running in this process.
 *
 * Static, because the thing it describes is: tor keeps process-global state
 * and cannot be torn down and started again — see the note where `reload()`
 * used to be. A rebuilt plugin object must not launch a second one, so this
 * outlives any individual `TorService`.
 */
private var torAlreadyRunning = false

final class TorService {
    /// How the client reports what it is doing.
    typealias Progress = (_ state: String, _ detail: [String: Any]) -> Void

    private let emit: Progress

    private var thread: TorThread?
    private var controller: TorController?
    private var configuration: TorConfiguration?

    /// The loopback port tor forwards onion traffic to. The transport listens there.
    private var forwardTo: UInt16 = 0

    /// Where the sync service forwards. The device link listens there.
    private var forwardSyncTo: UInt16 = 0

    /// Where tor writes the control port it chose. An ordinary file.
    private var controlPortFile: URL?

    /// Where tor writes its own account of what went wrong.
    private var logFile: URL?

    private(set) var running = false
    private(set) var bootstrapped = false
    private(set) var onion: String?

    /// This device's sync address, once its own service is published.
    private(set) var syncOnion: String?
    private(set) var socksPort: UInt16 = 0
    private(set) var lastError: String?

    /**
     * Whether this launch configured the account service at all.
     *
     * Read by `readOnionAddress`, which would otherwise pick up the hostname
     * file left by an earlier launch and report an address this device is
     * deliberately not answering at.
     */
    private(set) var publishesAccount = true

    /**
     * What the launch that actually started tor decided about the account
     * service, for as long as this process lives.
     *
     * Static because tor outlives this object: a WebView reload rebuilds every
     * Capacitor plugin while tor carries on running in the same process, and
     * the new instance would otherwise have no way to find out what the old one
     * configured. Nil until tor has been started here at all.
     */
    private static var launchedWithAccount: Bool?

    init(emit: @escaping Progress) {
        self.emit = emit
    }

    // ---- starting -----------------------------------------------------------

    /**
     * Start tor and publish an onion service pointing at `localPort`.
     *
     * Returns as soon as the process is launched. Bootstrapping a circuit takes
     * anywhere from a few seconds to a couple of minutes on a bad network, and
     * publishing the service descriptor takes longer again — so both are
     * reported as events rather than waited for. A promise held open that long
     * is indistinguishable from a hang.
     */
    /**
     * `account` decides whether the account address is published at all.
     *
     * Exactly one device may answer at an account address — an onion address is
     * a keypair, and two devices publishing descriptors for it means the
     * directory keeps whichever spoke last, so peers reach an arbitrary one and
     * nothing errors. The desktop enforces that by rewriting its torrc and
     * restarting; this build could not, because tor is not built to be torn
     * down and started again inside one process, so a displaced phone went on
     * publishing until it was next launched.
     *
     * Deciding it here, at launch, is what this build *can* do — the service
     * directory is read once at startup, so the decision has the same grain as
     * the launch itself. A phone that was displaced while it was closed comes
     * back up quiet, which is the case that actually happens.
     *
     * Defaults to true, so any caller that does not pass it behaves exactly as
     * this did before the parameter existed.
     */
    func start(localPort: UInt16, syncPort: UInt16 = 0, account: Bool = true) {
        if running { return }

        // Already up from before this object existed.
        //
        // The WebView can reload — importing an identity does exactly that —
        // and Capacitor rebuilds its plugins when it does. The new instance
        // knows nothing, while tor carries on running in the same process. It
        // must not be started twice; what it needs is to be told what is
        // already true.
        if torAlreadyRunning {
            running = true
            bootstrapped = true
            socksPort = SOCKS_PORT

            // What is *actually* published, which is not necessarily what this
            // call asked for. Nothing here configures tor — it is already
            // running, with whatever the launch that started it decided — so
            // taking `account` at its word would have the app believe it had
            // stopped publishing an address it is still answering at, or the
            // reverse. `launchedWithAccount` is the only honest source, and it
            // outlives the reload because it belongs to the process rather
            // than to this object.
            publishesAccount = Self.launchedWithAccount ?? account

            emit("ready", ["socksPort": Int(SOCKS_PORT)])

            // Both addresses come off disk, so they survive the reload too.
            readOnionAddress()
            return
        }

        // From here this call is the one configuring tor, so its answer is the
        // one that holds for as long as the process lives.
        publishesAccount = account
        Self.launchedWithAccount = account

        lastError = nil
        forwardTo = localPort
        forwardSyncTo = syncPort

        let configuration = TorConfiguration()
        configuration.ignoreMissingTorrc = true
        configuration.cookieAuthentication = true

        do {
            let dataDirectory = try Self.dataDirectory()
            let serviceDirectory = try Self.serviceDirectory()
            let syncDirectory = try Self.syncDirectory()

            // Where the second service forwards to. The same listener as the
            // first when nothing else was given, because the link server and
            // the peer transport both speak on demand and a device with one
            // port is still reachable at both addresses.
            let syncPort = forwardSyncTo > 0 ? forwardSyncTo : localPort

            configuration.dataDirectory = dataDirectory

            // A control *port* on loopback, not a control socket.
            //
            // A Unix domain socket path has to fit in `sockaddr_un.sun_path`,
            // which is 104 bytes on Darwin — and an iOS container path does not
            // leave room. Even `tmp/cp` is over the limit here:
            //
            //   /var/mobile/Containers/Data/Application/<36-char UUID>/tmp/cp
            //
            // Shortening the name was the obvious fix and it is not enough,
            // because the length is almost entirely the container prefix, which
            // is not ours to shorten. tor starts fine, the socket is never
            // created, and connecting to it fails with "no such file or
            // directory" — an error about a missing file when the real problem
            // is an address that cannot be expressed.
            //
            // A TCP control port on 127.0.0.1 has no such limit. `auto` lets
            // tor pick a free one and write it to a file, which is an ordinary
            // file and can live at any path length.
            let portFile = dataDirectory.appendingPathComponent("controlport")
            self.controlPortFile = portFile

            let logFile = dataDirectory.appendingPathComponent("tor.log")
            self.logFile = logFile
            try? FileManager.default.removeItem(at: logFile)

            // Not left over from a previous launch, or the first read would
            // return a port nothing is listening on.
            try? FileManager.default.removeItem(at: portFile)

            // ## Why this is built up rather than written as one literal
            //
            // The account service is conditional now — see `account` on
            // `start` — and the obvious way to express that, splicing an array
            // into a literal with `+`, does not compile. Not for any reason to
            // do with this code: a forty-element string literal carrying
            // interpolations, joined by operators whose operand types have to
            // be inferred, is the shape that makes Swift's type checker give up
            // rather than finish. It reports that as a failure to type-check
            // the expression in reasonable time, which reads like a mystery and
            // is really just a request to be more explicit.
            //
            // So every piece below is small and annotated, and nothing has to
            // be inferred across the whole thing.
            var arguments: [String] = [
                // Bound to loopback and to a port tor picks.
                // Fixed rather than `auto`. See `SOCKS_PORT` above — this is
                // the value that makes the proxy port knowable without asking
                // anybody.
                "--SocksPort", "\(SOCKS_PORT)",

                "--ControlPort", "auto",
                "--ControlPortWriteToFile", portFile.path,
            ]

            // ---- the account address, if this device is the one holding it --
            //
            // The three are an ordered unit: tor applies `HiddenServicePort`
            // and `HiddenServiceVersion` to whichever `HiddenServiceDir`
            // preceded them, so they all appear together or not at all.
            if account {
                let accountForward: String = "80 127.0.0.1:\(localPort)"

                arguments.append(contentsOf: ["--HiddenServiceDir", serviceDirectory.path])
                arguments.append(contentsOf: ["--HiddenServicePort", accountForward])

                // Version 3 addresses. The default now, stated anyway: v2 is
                // retired and an old default would be silently insecure.
                arguments.append(contentsOf: ["--HiddenServiceVersion", "3"])
            }

            // ---- the second service: this device's sync address ------------
            //
            // A separate onion, with its own key, used by nothing but the
            // other devices signed in as the same person.
            //
            // It has to be separate from the one above. The account's address
            // is published by exactly one device at a time — that is what stops
            // two of them fighting over it — so dialling it reaches whichever
            // device is already holding, which is precisely the one that does
            // not need to be reached. A phone that wants to take the account
            // over from a desktop at home has no way to say so through an
            // address the desktop owns.
            //
            // Published unconditionally, including while this device is
            // displaced. A device that is not holding is the one that most
            // needs to be reachable: it is how it finds out what it missed and
            // how it takes the account back.
            let syncForward: String = "80 127.0.0.1:\(syncPort)"

            arguments.append(contentsOf: ["--HiddenServiceDir", syncDirectory.path])
            arguments.append(contentsOf: ["--HiddenServicePort", syncForward])
            arguments.append(contentsOf: ["--HiddenServiceVersion", "3"])

            // Never a relay. The default already, said out loud because a
            // phone volunteering to carry other people's traffic would be a
            // surprising thing to discover by accident.
            arguments.append(contentsOf: ["--ClientOnly", "1"])

            // Logged to a file, and read back when something fails.
            //
            // This is the only way to find out what tor is unhappy about.
            // There is no console on a device, tor reports configuration
            // problems by writing a line and exiting, and every failure so far
            // has been diagnosed by guessing — which has cost a build cycle
            // each time. `SafeLogging` keeps addresses out of it, so the file
            // says what went wrong without recording who was being contacted.
            let logLine: String = "notice file \(logFile.path)"

            arguments.append(contentsOf: ["--Log", logLine])
            arguments.append(contentsOf: ["--SafeLogging", "1"])
            arguments.append(contentsOf: ["--AvoidDiskWrites", "1"])

            configuration.arguments = arguments

            self.configuration = configuration

            let thread = TorThread(configuration: configuration)
            self.thread = thread
            thread.start()

            running = true
            torAlreadyRunning = true

            // Reported now, before a circuit exists and before the control
            // connection is even attempted. Nothing has to go right for this
            // to be true: it is the number tor was told to use.
            socksPort = SOCKS_PORT
            emit("starting", ["socksPort": Int(SOCKS_PORT)])

            // Retried rather than attempted once after a fixed delay.
            //
            // tor creates the control socket some time after the thread
            // starts, and how long depends on the device and on how much work
            // it has to do first. A single attempt after one second is a guess
            // that is wrong often enough to look like a permanent failure.
            waitForControlSocket()
        } catch {
            lastError = "could not prepare Tor's directories: \(error.localizedDescription)"
            emit("failed", ["error": lastError as Any])
        }
    }

    /**
     * Wait for tor to create the control socket, then drive it.
     *
     * Polls rather than sleeps, and gives up with an honest message rather
     * than hanging: forty attempts at half a second is twenty seconds, which
     * is far longer than tor takes to open a socket on any device and short
     * enough that a genuine failure is reported while somebody is still
     * looking at the screen.
     */
    private func waitForControlSocket(attempt: Int = 0) {
        guard let portFile = controlPortFile else {
            fail("no control port file — tor cannot be driven")
            return
        }

        if let port = Self.readControlPort(portFile) {
            connectController(port: port)
            return
        }

        guard attempt < 40 else {
            fail("tor did not report a control port within twenty seconds")
            return
        }

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
            [weak self] in
            self?.waitForControlSocket(attempt: attempt + 1)
        }
    }

    /**
     * Read the port tor chose.
     *
     * The file holds one line: `PORT=127.0.0.1:51234`. It may exist while still
     * being written, so a line that does not parse is treated as "not yet"
     * rather than as a failure — which is what the retry above is for.
     */
    private static func readControlPort(_ file: URL) -> UInt16? {
        guard
            let text = try? String(contentsOf: file, encoding: .utf8),
            let line = text.split(separator: "\n").first(where: { $0.hasPrefix("PORT=") })
        else { return nil }

        return line
            .split(separator: ":")
            .last
            .flatMap { UInt16($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /**
     * Connect to tor's control port, retrying while it settles.
     *
     * `ControlPortWriteToFile` is written around the time the listener binds,
     * not reliably after it is accepting — so a single attempt can arrive a
     * fraction too early and be refused. `TORController.connect` reports that
     * by returning NO without filling in its `NSError**`, which Swift turns
     * into `Foundation._GenericObjCError error 0`: an error object that says
     * nothing at all, for a condition that resolves itself in a moment.
     *
     * Ten attempts over five seconds, and only then a message that says what
     * was actually being attempted.
     */
    private func connectController(port: UInt16, attempt: Int = 0) {
        guard let configuration = configuration else { return }

        let controller = TorController(socketHost: "127.0.0.1", port: port)
        self.controller = controller

        // Attempted, and a thrown result is not treated as failure.
        //
        // tor's own log settles this: every attempt produced
        //
        //     [notice] New control connection opened from 127.0.0.1.
        //
        // one line per retry. The socket connects and tor accepts it — and
        // `connect` still returns NO with no error to explain itself, which
        // Swift surfaces as `_GenericObjCError error 0`. Whatever that return
        // value means in this version of Tor.framework, it does not mean the
        // connection failed, and believing it meant retrying against a control
        // port that was working the entire time.
        //
        // Authentication is the honest test, and it has a completion handler
        // that reports a real error. So the outcome is decided there.
        try? controller.connect()

        guard let cookie = configuration.cookie else {
            // Written into the data directory by tor at startup. Same race as
            // the control port, same treatment — retrying costs half a second
            // and giving up costs the whole network.
            guard attempt < 10 else {
                fail("tor never wrote its control cookie, so it cannot be authenticated to")
                return
            }

            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
                [weak self] in
                self?.connectController(port: port, attempt: attempt + 1)
            }
            return
        }

        controller.authenticate(with: cookie) { [weak self] success, error in
            guard let self else { return }

            guard success else {
                // The first meaningful signal about the control connection. If
                // it were genuinely not open, this is where that shows up.
                self.fail(
                    "tor accepted the control connection but refused "
                    + "authentication: \(error?.localizedDescription ?? "no reason given")"
                )
                return
            }

            self.emit("controlling", [:])

            // Progress, so the interface can say "connecting" honestly rather
            // than showing a spinner for two minutes with nothing behind it.
            controller.addObserver(forStatusEvents: {
                [weak self] (type, severity, action, arguments) -> Bool in
                guard type == "STATUS_CLIENT", action == "BOOTSTRAP" else { return false }

                let percent = arguments?["PROGRESS"].flatMap { Int($0) } ?? 0
                self?.emit("bootstrapping", [
                    "percent": percent,
                    "summary": arguments?["SUMMARY"] as Any,
                ])
                return true
            })

            controller.addObserver(forCircuitEstablished: { [weak self] established in
                guard let self, established, !self.bootstrapped else { return }

                self.bootstrapped = true
                self.readSocksPort()
                self.readOnionAddress()
            })
        }
    }

    // ---- what the transport needs to know -----------------------------------

    /**
     * Confirm the SOCKS port, rather than discover it.
     *
     * The port is fixed and already reported by the time this runs — see
     * `SOCKS_PORT`. This asks tor what it actually bound so a disagreement is
     * visible in the log instead of showing up later as connections that go
     * nowhere. It never fails the client: a mismatch here would mean tor
     * ignored its own configuration, which it does not do quietly.
     */
    private func readSocksPort() {
        socksPort = SOCKS_PORT
        emit("ready", ["socksPort": Int(SOCKS_PORT)])

        controller?.getInfoForKeys(["net/listeners/socks"]) { [weak self] values in
            guard let self else { return }

            // Reported as `"127.0.0.1:51234"`, quotes included.
            let raw = values.first ?? ""
            let bound = raw
                .replacingOccurrences(of: "\"", with: "")
                .split(separator: ":")
                .last
                .flatMap { UInt16($0) }

            if let bound, bound != SOCKS_PORT {
                self.emit("log", ["line": "tor bound SOCKS on \(bound), not \(SOCKS_PORT)"])
                self.socksPort = bound
                self.emit("ready", ["socksPort": Int(bound)])
            }
        }
    }

    /**
     * This device's sync address, once its service has published.
     *
     * Split out of `readOnionAddress` because a displaced device reads only
     * this half — it publishes no account service, so there is no account
     * address for it to be waiting on.
     *
     * It publishes on its own schedule and may well arrive first, so it is
     * picked up whenever it appears rather than waited for: a device reachable
     * by its siblings before it is reachable by its friends is an ordinary
     * state, and worth reporting as soon as it is true.
     */
    private func readSyncAddress() {
        guard syncOnion == nil, let syncDirectory = try? Self.syncDirectory() else { return }

        let syncHostname = syncDirectory.appendingPathComponent("hostname")

        guard let text = try? String(contentsOf: syncHostname, encoding: .utf8) else { return }

        let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return }

        syncOnion = address
        emit("sync", ["syncOnion": address])
    }

    /**
     * The address this device answers at.
     *
     * Written by tor into the service directory once the descriptor is
     * published. It does not exist at the moment the circuit is established, so
     * this retries rather than reporting an empty address — which the interface
     * would show as "you are unreachable" while tor was still working.
     */
    private func readOnionAddress(attempt: Int = 0) {
        guard let directory = try? Self.serviceDirectory() else { return }
        let hostname = directory.appendingPathComponent("hostname")

        // A displaced device still has the hostname file from the last launch
        // that did publish, and reading it would report an address this device
        // is deliberately not answering at — which then travels into friend
        // codes and the interface's idea of where it can be reached. The file
        // is kept, because the key behind it is how the address comes back.
        if !publishesAccount {
            readSyncAddress()
            if syncOnion == nil { keepReadingSyncAddress() }
            return
        }

        readSyncAddress()

        if let text = try? String(contentsOf: hostname, encoding: .utf8) {
            let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !address.isEmpty {
                onion = address
                emit("published", [
                    "onion": address,
                    "syncOnion": syncOnion as Any,
                    "socksPort": Int(socksPort),
                ])

                // Kept going if the sync address has not appeared yet. The two
                // services publish independently and stopping here would leave
                // the second one permanently unreported.
                if syncOnion == nil { self.keepReadingSyncAddress() }
                return
            }
        }

        // Publishing a descriptor takes a little while on a fresh service, and
        // longer on a slow network. Thirty attempts at two seconds is a minute.
        guard attempt < 30 else {
            fail("the onion service did not publish — this device is reachable outbound only")
            return
        }

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.readOnionAddress(attempt: attempt + 1)
        }
    }

    /**
     * Keep looking for the sync address after the account address has arrived.
     *
     * The two services publish independently, and the account one usually wins
     * because it is listed first. `readOnionAddress` returns as soon as it has
     * what it was called for, so without this the second address would be
     * looked for exactly once and then never again — and a device whose
     * siblings cannot reach it has no way to say so.
     */
    private func keepReadingSyncAddress(attempt: Int = 0) {
        if syncOnion != nil { return }

        if let directory = try? Self.syncDirectory(),
           let text = try? String(
               contentsOf: directory.appendingPathComponent("hostname"),
               encoding: .utf8
           ) {
            let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !address.isEmpty {
                syncOnion = address
                emit("sync", ["syncOnion": address])
                return
            }
        }

        // Two minutes, matching the account service. Given up on quietly: a
        // device with no sync address still works, it simply has to be the one
        // that dials rather than the one that answers.
        guard attempt < 30 else { return }

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.keepReadingSyncAddress(attempt: attempt + 1)
        }
    }

    // ---- stopping -----------------------------------------------------------

    func stop() {
        controller?.disconnect()
        controller = nil

        thread?.cancel()
        thread = nil

        configuration = nil
        running = false
        bootstrapped = false
        socksPort = 0
        onion = nil
        syncOnion = nil

        emit("stopped", [:])
    }

    /**
     * Report a failure, with tor's own words attached.
     *
     * Every failure in this file so far has been a guess checked by rebuilding
     * — and tor knew the answer the whole time. It writes a line saying exactly
     * what it objected to and then exits, which from the outside looks like a
     * control port that will not accept connections.
     */
    private func fail(_ message: String) {
        var full = message

        if let tail = Self.lastLogLines(logFile) {
            full += "\n\ntor said:\n" + tail
        }

        lastError = full
        emit("failed", ["error": full])
    }

    /// The end of tor's log — where it says why it stopped.
    private static func lastLogLines(_ file: URL?, keep: Int = 12) -> String? {
        guard
            let file,
            let text = try? String(contentsOf: file, encoding: .utf8)
        else { return nil }

        let lines = text
            .split(separator: "\n", omittingEmptySubsequences: true)
            .suffix(keep)

        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    // ---- where things are kept ----------------------------------------------

    /**
     * Tor's working directory.
     *
     * Under Application Support rather than Documents: it is not the user's
     * data, and Documents is visible in the Files app on a device with file
     * sharing enabled.
     */
    private static func dataDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )

        let directory = base.appendingPathComponent("tor", isDirectory: true)
        try create(directory)
        return directory
    }

    /**
     * The hidden service directory, which holds the key that is the address.
     *
     * tor refuses to start if this is readable by anyone else, so the
     * permissions are not a precaution — they are a precondition.
     */
    private static func serviceDirectory() throws -> URL {
        let directory = try dataDirectory()
            .appendingPathComponent("service", isDirectory: true)

        try create(directory)

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory.path
        )

        return directory
    }

    /**
     * The second service's directory: this device's own address.
     *
     * Beside the first rather than inside it, because tor takes a directory
     * per service and will refuse to share one. Same protection, same
     * exclusion from backup — a sync key restored onto a second phone would
     * give two devices one sync address, which is the same collision this
     * whole arrangement exists to avoid, one level down.
     */
    private static func syncDirectory() throws -> URL {
        let directory = try dataDirectory()
            .appendingPathComponent("sync-service", isDirectory: true)

        try create(directory)

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory.path
        )

        return directory
    }

    private static func create(_ directory: URL) throws {
        var directory = directory

        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }

        // Not backed up. The private key here is this device's identity on the
        // network; a copy restored onto a second device would have two of them
        // publishing the same address, which tor resolves by one of them
        // winning arbitrarily.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)

        // Unreadable while the device is locked. The app keeps running in the
        // background — see the keepalive plugin — so this file is reachable at
        // times when the screen is off and the phone is in somebody's pocket.
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
    }

    // ---- moving the address to another device -------------------------------
    //
    // The comment at the top of this file says the service key is deliberately
    // excluded from backup, and that is still true of *automatic* backup —
    // iCloud must not carry it, because a restore onto a second phone the user
    // has forgotten about would silently produce two devices publishing one
    // address.
    //
    // A deliberate export is a different thing. The address in a friend code is
    // this key: an account restored without it keeps its name, its friends list
    // and its place in every server, and cannot be reached by a single one of
    // the codes its owner handed out. That is not a degraded restore, it is a
    // useless one. So the key travels, inside the same passphrase-encrypted
    // bundle as the signing key, and the interface is explicit that the old
    // device stops being reachable the moment the new one publishes.

    private static let secretFile = "hs_ed25519_secret_key"
    private static let publicFile = "hs_ed25519_public_key"
    private static let hostnameFile = "hostname"

    private static let secretTag = "== ed25519v1-secret: type0 =="
    private static let publicTag = "== ed25519v1-public: type0 =="

    /// tor's header: the tag in ASCII, zero-padded to 32 bytes.
    private static func tag(_ text: String) -> Data {
        var padded = Data(count: 32)
        let ascii = Data(text.utf8)
        padded.replaceSubrange(0..<ascii.count, with: ascii)
        return padded
    }

    /**
     * This device's service key, or empty strings if it has none yet.
     *
     * Absent is a normal answer rather than an error — Tor may never have been
     * started on this device. The caller decides what that means; for a backup
     * it means the bundle carries no address, which is worth saying rather than
     * refusing to write a backup at all.
     */
    static func exportKey() -> [String: String] {
        guard let directory = try? serviceDirectory() else {
            return ["secret": "", "public": "", "hostname": ""]
        }

        let secret = try? Data(contentsOf: directory.appendingPathComponent(secretFile))
        let publicKey = try? Data(contentsOf: directory.appendingPathComponent(publicFile))

        guard let secret, let publicKey else {
            return ["secret": "", "public": "", "hostname": ""]
        }

        let hostname = (try? String(
            contentsOf: directory.appendingPathComponent(hostnameFile),
            encoding: .utf8
        ))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        return [
            "secret": secret.base64EncodedString(),
            "public": publicKey.base64EncodedString(),
            "hostname": hostname,
        ]
    }

    /**
     * Write a service key from a backup, and answer at that address from now on.
     *
     * The `hostname` file is written only when the bundle carries one that is
     * the right shape, and is not otherwise derived here. Deriving it needs
     * SHA3-256, which this platform's crypto library does not provide — and
     * tor rewrites the file from the public key at every startup regardless, so
     * a hand-written one would be replaced by the truth within seconds anyway.
     * What is here is a placeholder so the address can be shown immediately
     * rather than after a restart.
     */
    static func importKey(secret: Data, publicKey: Data, hostname: String) throws {
        // `Data(...)` around the slice on purpose: a prefix keeps the indices
        // of the buffer it came from, and comparing a re-indexed slice is the
        // kind of thing that works until the day the input arrives with a
        // different offset.
        guard secret.count == 96, Data(secret.prefix(32)) == tag(secretTag) else {
            throw TorKeyError.malformed("the onion secret key is not in tor's format")
        }

        guard publicKey.count == 64, Data(publicKey.prefix(32)) == tag(publicTag) else {
            throw TorKeyError.malformed("the onion public key is not in tor's format")
        }

        let directory = try serviceDirectory()

        try secret.write(
            to: directory.appendingPathComponent(secretFile),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        try publicKey.write(
            to: directory.appendingPathComponent(publicFile),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )

        let address = hostname.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let target = directory.appendingPathComponent(hostnameFile)

        if address.hasSuffix(".onion"), address.count == 62 {
            try? Data((address + "\n").utf8).write(to: target, options: [.atomic])
        } else {
            // Stale, and worse than absent: it would be read and reported as
            // this device's address while tor published a different one.
            try? FileManager.default.removeItem(at: target)
        }

        for file in [secretFile, publicFile, hostnameFile] {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: directory.appendingPathComponent(file).path
            )
        }
    }

    // `reload()` used to live here, and it is gone rather than left unused.
    //
    // It stopped the client and started it again so an imported address would
    // take effect immediately. tor is not built for that: it is a program with
    // process-global state that is set up once, and Tor.framework runs it on a
    // thread that cannot meaningfully be cancelled and replaced. Doing it
    // crashed the app natively during an identity import, which is the worst
    // possible moment and the hardest kind of crash to trace, because nothing
    // on the JavaScript side is told anything at all.
    //
    // The address is picked up at the next launch instead.
}

enum TorKeyError: LocalizedError {
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .malformed(let reason): return reason
        }
    }
}
