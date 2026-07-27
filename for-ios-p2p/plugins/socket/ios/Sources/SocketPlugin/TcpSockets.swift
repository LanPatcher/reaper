import Foundation
import Network

/**
 * TCP for the WebView.
 *
 * A WebView has fetch and WebSockets and nothing that speaks a raw stream, and
 * the Reaper transport is a raw stream: length-prefixed encrypted frames over
 * a socket that stays open. So the sockets live out here and the JavaScript
 * drives them by id.
 *
 * ## Why Network.framework
 *
 * Rather than BSD sockets, which would also work. Two reasons that matter on a
 * phone rather than a desktop:
 *
 *   - **It survives the network changing.** Walking out of the house moves the
 *     device from Wi-Fi to cellular, and `NWConnection` reports that as a state
 *     change instead of a socket that silently stops delivering.
 *   - **It is allowed to run in the background.** Raw sockets on a suspended
 *     app are closed by the system; these are managed and report their state
 *     honestly when the app comes back.
 *
 * ## Talking to Tor
 *
 * Every Reaper connection is to an onion address, which no TCP stack can
 * resolve. The address is handed to a SOCKS5 proxy instead — the Tor client
 * embedded in the app — and the handshake for that is implemented here rather
 * than in JavaScript, because it has to happen before the first byte of the
 * real protocol and the layer above should not have to know it happened.
 *
 * See `SOCKS5` below. It is the minimum: no authentication, domain-name
 * addressing, one reply.
 */

/** Bytes flowing one way, and the ids the WebView knows a socket by. */
final class TcpSockets {
  /** How a socket reports what happened to it. */
  typealias Events = (
    _ id: String,
    _ event: String,
    _ payload: [String: Any]
  ) -> Void

  private let queue = DispatchQueue(label: "chat.reaper.sockets")
  private var connections: [String: NWConnection] = [:]
  private var listener: NWListener?
  private let emit: Events

  init(emit: @escaping Events) {
    self.emit = emit
  }

  // ---- outbound ------------------------------------------------------------

  /**
   * Open a connection through the local SOCKS5 proxy.
   *
   * `host` is an onion address. It is never resolved here — that is the entire
   * point of routing through Tor, and a DNS lookup for it would both fail and
   * tell the local resolver who is being contacted.
   */
  func connect(
    id: String,
    host: String,
    port: UInt16,
    proxyPort: UInt16
  ) {
    let endpoint = NWEndpoint.hostPort(
      host: .init("127.0.0.1"),
      port: .init(rawValue: proxyPort) ?? 9050
    )

    let options = NWProtocolTCP.Options()
    // The transport sends small frames that matter immediately — a keystroke
    // indicator, a call answer — and Nagle would hold them back to combine
    // them with whatever comes next.
    options.noDelay = true
    // Long enough to survive a quiet connection, short enough to notice a peer
    // that has gone away.
    options.enableKeepalive = true
    options.keepaliveIdle = 30

    let connection = NWConnection(
      to: endpoint,
      using: NWParameters(tls: nil, tcp: options)
    )

    connections[id] = connection

    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }

      switch state {
      case .ready:
        // Connected to the proxy, not to the peer. The handshake is what turns
        // one into the other, and only then is the socket usable.
        self.socks5(id: id, connection: connection, host: host, port: port)

      case .failed(let error):
        self.emit(id, "error", ["message": error.localizedDescription])
        self.close(id: id)

      case .cancelled:
        self.emit(id, "close", [:])

      default:
        break
      }
    }

    connection.start(queue: queue)
  }

  // ---- inbound -------------------------------------------------------------

  /**
   * Accept connections from the Tor client.
   *
   * Bound to loopback only. An onion service is reached by Tor forwarding to a
   * local port, so nothing outside this device should ever be able to open
   * this — and binding it to every interface would put an unauthenticated
   * Reaper transport on the local Wi-Fi.
   */
  /**
   * Bind a loopback port and report which one was granted.
   *
   * Asynchronous, and it has to be. `NWListener.port` is nil until the
   * listener reaches `.ready`, and `start` returns immediately — so reading it
   * on the next line yields nothing and the caller falls back to the port it
   * asked for. Asking for zero means "choose one for me", so the caller was
   * told the port was zero, Tor was handed a forwarding target of zero, and
   * refused to start with "localPort is required".
   *
   * The symptom was "nothing can be sent or received", four layers away from a
   * value read one line too early.
   */
  func listen(port: UInt16, then: @escaping (Result<UInt16, Error>) -> Void) {
    stopListening()

    let options = NWProtocolTCP.Options()
    options.noDelay = true

    let parameters = NWParameters(tls: nil, tcp: options)
    parameters.allowLocalEndpointReuse = true

    // Only pinned when a specific port was asked for. Requiring an endpoint of
    // port zero asks the system to bind port zero literally, rather than to
    // pick a free one.
    if port != 0 {
      parameters.requiredLocalEndpoint = NWEndpoint.hostPort(
        host: .init("127.0.0.1"),
        port: .init(rawValue: port) ?? .any
      )
    }

    let listener: NWListener
    do {
      listener = try NWListener(using: parameters)
    } catch {
      then(.failure(error))
      return
    }

    // Answered once, whichever way it goes.
    var answered = false
    let settle: (Result<UInt16, Error>) -> Void = { outcome in
      if answered { return }
      answered = true
      then(outcome)
    }

    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        guard let bound = listener.port?.rawValue else {
          settle(.failure(NSError(
            domain: "chat.reaper.sockets", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "listener is ready but reported no port"]
          )))
          return
        }
        settle(.success(bound))

      case .failed(let error):
        settle(.failure(error))

      case .cancelled:
        settle(.failure(NSError(
          domain: "chat.reaper.sockets", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "listener was cancelled before it bound"]
        )))

      default:
        break
      }
    }

    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }

      let id = "in-\(UUID().uuidString)"
      self.connections[id] = connection

      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          self.emit(id, "accept", [:])
          self.read(id: id, connection: connection)
        case .failed(let error):
          self.emit(id, "error", ["message": error.localizedDescription])
          self.close(id: id)
        case .cancelled:
          self.emit(id, "close", [:])
        default:
          break
        }
      }

      connection.start(queue: self.queue)
    }

    listener.start(queue: queue)
    self.listener = listener
  }

  func stopListening() {
    listener?.cancel()
    listener = nil
  }

  // ---- moving bytes --------------------------------------------------------

  func send(id: String, data: Data) {
    guard let connection = connections[id] else { return }

    connection.send(
      content: data,
      completion: .contentProcessed { [weak self] error in
        guard let error else { return }
        self?.emit(id, "error", ["message": error.localizedDescription])
        self?.close(id: id)
      }
    )
  }

  /**
   * Read forever, handing each chunk up as it arrives.
   *
   * No framing here. The transport already length-prefixes its own frames and
   * has to cope with a chunk that is half a frame or three of them, because
   * that is what TCP does — reimplementing that boundary logic in Swift would
   * be a second copy of it to keep in step.
   */
  private func read(id: String, connection: NWConnection) {
    connection.receive(
      minimumIncompleteLength: 1,
      maximumLength: 64 * 1024
    ) { [weak self] data, _, complete, error in
      guard let self else { return }

      if let data, !data.isEmpty {
        self.emit(id, "data", ["data": data.base64EncodedString()])
      }

      if let error {
        self.emit(id, "error", ["message": error.localizedDescription])
        self.close(id: id)
        return
      }

      if complete {
        self.close(id: id)
        return
      }

      self.read(id: id, connection: connection)
    }
  }

  func close(id: String) {
    guard let connection = connections.removeValue(forKey: id) else { return }
    connection.cancel()
  }

  func closeAll() {
    for id in connections.keys { close(id: id) }
    stopListening()
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

  private func socks5(
    id: String,
    connection: NWConnection,
    host: String,
    port: UInt16
  ) {
    let greeting = Data([0x05, 0x01, 0x00])

    connection.send(content: greeting, completion: .contentProcessed { [weak self] error in
      guard let self else { return }

      if let error {
        self.emit(id, "error", ["message": "proxy: \(error.localizedDescription)"])
        self.close(id: id)
        return
      }

      self.expect(id: id, connection: connection, bytes: 2) { choice in
        guard choice.count == 2, choice[0] == 0x05, choice[1] == 0x00 else {
          self.emit(id, "error", ["message": "proxy refused the connection"])
          self.close(id: id)
          return
        }

        self.socks5Connect(id: id, connection: connection, host: host, port: port)
      }
    })
  }

  private func socks5Connect(
    id: String,
    connection: NWConnection,
    host: String,
    port: UInt16
  ) {
    guard let name = host.data(using: .utf8), name.count <= 255 else {
      emit(id, "error", ["message": "address too long"])
      close(id: id)
      return
    }

    var request = Data([0x05, 0x01, 0x00, 0x03, UInt8(name.count)])
    request.append(name)
    request.append(UInt8(port >> 8))
    request.append(UInt8(port & 0xff))

    connection.send(content: request, completion: .contentProcessed { [weak self] error in
      guard let self else { return }

      if let error {
        self.emit(id, "error", ["message": "proxy: \(error.localizedDescription)"])
        self.close(id: id)
        return
      }

      // The reply header is four bytes plus a bound address whose length
      // depends on its type, so it is read in two parts rather than guessed.
      self.expect(id: id, connection: connection, bytes: 4) { head in
        guard head.count == 4, head[0] == 0x05 else {
          self.emit(id, "error", ["message": "bad proxy reply"])
          self.close(id: id)
          return
        }

        guard head[1] == 0x00 else {
          self.emit(id, "error", ["message": Self.socksError(head[1])])
          self.close(id: id)
          return
        }

        let trailing: Int
        switch head[3] {
        case 0x01: trailing = 4 + 2            // IPv4 and port
        case 0x04: trailing = 16 + 2           // IPv6 and port
        case 0x03: trailing = -1               // length-prefixed name
        default:
          self.emit(id, "error", ["message": "unknown address type"])
          self.close(id: id)
          return
        }

        let finish = {
          self.emit(id, "connect", [:])
          self.read(id: id, connection: connection)
        }

        if trailing >= 0 {
          self.expect(id: id, connection: connection, bytes: trailing) { _ in finish() }
        } else {
          self.expect(id: id, connection: connection, bytes: 1) { length in
            guard let count = length.first else {
              self.close(id: id)
              return
            }
            self.expect(id: id, connection: connection, bytes: Int(count) + 2) { _ in
              finish()
            }
          }
        }
      }
    })
  }

  /**
   * Read exactly this many bytes.
   *
   * `receive(minimumIncompleteLength:maximumLength:)` with both set to the same
   * value will not return short, which is what the handshake needs — every
   * field in it is fixed-length and reading one byte too few desynchronises
   * everything after.
   */
  private func expect(
    id: String,
    connection: NWConnection,
    bytes: Int,
    then: @escaping (Data) -> Void
  ) {
    connection.receive(
      minimumIncompleteLength: bytes,
      maximumLength: bytes
    ) { [weak self] data, _, _, error in
      guard let self else { return }

      if let error {
        self.emit(id, "error", ["message": "proxy: \(error.localizedDescription)"])
        self.close(id: id)
        return
      }

      guard let data, data.count == bytes else {
        self.emit(id, "error", ["message": "proxy closed during handshake"])
        self.close(id: id)
        return
      }

      then(data)
    }
  }

  private static func socksError(_ code: UInt8) -> String {
    switch code {
    case 0x01: return "proxy failed"
    case 0x02: return "not allowed"
    case 0x03: return "network unreachable"
    case 0x04: return "host unreachable — the onion service may be offline"
    case 0x05: return "connection refused"
    case 0x06: return "timed out"
    default: return "proxy error \(code)"
    }
  }
}
