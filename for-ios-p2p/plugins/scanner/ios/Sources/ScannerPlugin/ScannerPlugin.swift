import AVFoundation
import Capacitor
import Foundation

/**
 * `ScannerView` as seen from the WebView.
 *
 * Thin, like the others: the camera work is in `ScannerView.swift` and this is
 * the part that talks to JavaScript, asks for permission, and gets everything
 * onto the main thread.
 */
@objc(ScannerPlugin)
public class ScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScannerPlugin"
    public let jsName = "Scanner"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    @objc func scan(_ call: CAPPluginCall) {
        let status = AVCaptureDevice.authorizationStatus(for: .video)

        switch status {
        case .authorized:
            present(call)

        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard granted else {
                    // Refused just now. Not an error worth alarming anybody
                    // with — the address can still be typed — but the caller
                    // has to be able to tell it apart from a scan that found
                    // nothing, or it will sit waiting for a camera that is
                    // never going to open.
                    call.reject("the camera was not allowed")
                    return
                }
                self?.present(call)
            }

        default:
            call.reject(
                "Reaper does not have permission to use the camera. "
                + "It can be granted in Settings."
            )
        }
    }

    /**
     * Show the camera.
     *
     * On the main thread, because presenting a view controller from anywhere
     * else is a crash rather than a warning — and this is reached from a
     * permission callback, which arrives on an arbitrary queue.
     */
    private func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let host = self?.bridge?.viewController else {
                call.reject("there is no window to show the camera in")
                return
            }

            let scanner = ScannerView()
            scanner.modalPresentationStyle = .fullScreen

            scanner.finished = { text in
                // `null` for a cancel rather than a rejection: backing out is
                // an ordinary thing to do, and making it an error means every
                // call site needs a `catch` that has to work out whether
                // anything actually went wrong.
                call.resolve(["text": text as Any])
            }

            host.present(scanner, animated: true)
        }
    }
}
