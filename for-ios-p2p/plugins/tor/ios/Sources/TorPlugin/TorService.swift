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
final class TorService {
    /// How the client reports what it is doing.
    typealias Progress = (_ state: String, _ detail: [String: Any]) -> Void

    private let emit: Progress

    private var thread: TORThread?
    private var controller: TORController?
    private var configuration: TORConfiguration?

    /// The loopback port tor forwards onion traffic to. The transport listens there.
    private var forwardTo: UInt16 = 0

    private(set) var running = false
    private(set) var bootstrapped = false
    private(set) var onion: String?
    private(set) var socksPort: UInt16 = 0
    private(set) var lastError: String?

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
    func start(localPort: UInt16) {
        if running { return }

        lastError = nil
        forwardTo = localPort

        let configuration = TORConfiguration()

        // Ports chosen by tor rather than fixed. A hard-coded 9050 collides
        // with anything else on the device using it, and the failure is a
        // refusal to start that looks like Tor being broken.
        configuration.socksURL = nil
        configuration.ignoreMissingTorrc = true
        configuration.cookieAuthentication = true
        configuration.autoControlPort = true

        do {
            let dataDirectory = try Self.dataDirectory()
            let serviceDirectory = try Self.serviceDirectory()

            configuration.dataDirectory = dataDirectory

            // The country database. Without it tor cannot weight entry guards
            // properly, which is a real anonymity property rather than a
            // nicety — see the GeoIP subspec in ReaperTor.podspec.
            configuration.geoipFile = Bundle.geoIpBundle?.geoipFile
            configuration.geoip6File = Bundle.geoIpBundle?.geoip6File

            configuration.arguments = [
                // Bound to loopback and to a port tor picks.
                "--SocksPort", "auto",

                // The onion service. These two are an ordered pair — tor
                // applies `HiddenServicePort` to whichever `HiddenServiceDir`
                // preceded it — which is why they are arguments rather than
                // entries in `options`, where order is not preserved.
                "--HiddenServiceDir", serviceDirectory.path,
                "--HiddenServicePort", "80 127.0.0.1:\(localPort)",

                // Version 3 addresses. The default now, stated anyway: v2 is
                // retired and an old default would be silently insecure.
                "--HiddenServiceVersion", "3",

                // A phone moves between networks constantly. Without this, tor
                // keeps trying circuits through an interface that is gone.
                "--ClientOnly", "0",

                // Nothing to log to on a device, and a log file is a record of
                // who was contacted when.
                "--Log", "notice stdout",
                "--SafeLogging", "1",
                "--AvoidDiskWrites", "1",
            ]

            self.configuration = configuration

            let thread = TORThread(configuration: configuration)
            self.thread = thread
            thread.start()

            running = true
            emit("starting", [:])

            // The control port is not up the instant the thread starts.
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.connectController()
            }
        } catch {
            lastError = "could not prepare Tor's directories: \(error.localizedDescription)"
            emit("failed", ["error": lastError as Any])
        }
    }

    private func connectController() {
        guard let configuration = configuration else { return }

        guard let controlURL = configuration.controlSocket ?? configuration.controlPortFile else {
            fail("tor did not report a control port")
            return
        }

        let controller = TORController(socketURL: controlURL)
        self.controller = controller

        do {
            try controller.connect()
        } catch {
            fail("control port: \(error.localizedDescription)")
            return
        }

        guard let cookie = configuration.cookie else {
            fail("no control cookie — tor is running but cannot be driven")
            return
        }

        controller.authenticate(with: cookie) { [weak self] success, error in
            guard let self else { return }

            guard success else {
                self.fail("authentication: \(error?.localizedDescription ?? "refused")")
                return
            }

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

    private func readSocksPort() {
        controller?.getInfoForKeys(["net/listeners/socks"]) { [weak self] values in
            guard let self else { return }

            // Reported as `"127.0.0.1:51234"`, quotes included.
            let raw = values.first ?? ""
            let port = raw
                .replacingOccurrences(of: "\"", with: "")
                .split(separator: ":")
                .last
                .flatMap { UInt16($0) }

            guard let port else {
                self.fail("tor did not report a SOCKS port")
                return
            }

            self.socksPort = port
            self.emit("ready", ["socksPort": Int(port)])
        }
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

        if let text = try? String(contentsOf: hostname, encoding: .utf8) {
            let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !address.isEmpty {
                onion = address
                emit("published", ["onion": address, "socksPort": Int(socksPort)])
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

        emit("stopped", [:])
    }

    private func fail(_ message: String) {
        lastError = message
        emit("failed", ["error": message])
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
}
