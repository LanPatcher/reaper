import AVFoundation
import UIKit

/**
 * A full-screen camera that reports the first QR code it sees.
 *
 * `AVCaptureMetadataOutput` does the reading. Nothing here looks at pixels:
 * the system already has a detector that is better than anything worth writing
 * and is the same one every other app on the device uses.
 *
 * The whole thing exists to pair two of your own devices. A desktop shows its
 * sync address as a code, and typing sixty-two base32 characters on a phone
 * without a mistake is not a reasonable thing to ask.
 */
final class ScannerView: UIViewController {
    /// Called once, with the code or with nothing if the user backed out.
    var finished: ((String?) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    /// Answered once. A metadata callback can fire several times in a frame.
    private var answered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            // No camera, or it is already in use. Reported as nothing found
            // rather than as a crash — the address can still be typed.
            answer(nil)
            return
        }

        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { answer(nil); return }

        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)

        // QR only. Accepting every barcode type the device can read means a
        // shop receipt in view is a "successful" scan.
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)
        self.preview = preview

        addChrome()

        // Off the main thread: starting a capture session blocks for a
        // noticeable moment, and doing it here freezes the presentation
        // animation half way.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    /// A target to aim at, and a way out.
    private func addChrome() {
        let box = UIView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.layer.borderColor = UIColor.white.cgColor
        box.layer.borderWidth = 2
        box.layer.cornerRadius = 12
        view.addSubview(box)

        let hint = UILabel()
        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.text = "Point at the code on your other device"
        hint.textColor = .white
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.font = .systemFont(ofSize: 15, weight: .medium)
        view.addSubview(hint)

        let cancel = UIButton(type: .system)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        cancel.addTarget(self, action: #selector(cancelled), for: .touchUpInside)
        view.addSubview(cancel)

        let guide = view.safeAreaLayoutGuide

        NSLayoutConstraint.activate([
            box.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            box.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            box.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.7),
            box.heightAnchor.constraint(equalTo: box.widthAnchor),

            hint.topAnchor.constraint(equalTo: box.bottomAnchor, constant: 24),
            hint.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 32),
            hint.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -32),

            cancel.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    @objc private func cancelled() {
        answer(nil)
    }

    private func answer(_ text: String?) {
        guard !answered else { return }
        answered = true

        if session.isRunning { session.stopRunning() }

        dismiss(animated: true) { [weak self] in
            self?.finished?(text)
        }
    }
}

extension ScannerView: AVCaptureMetadataOutputObjectsDelegate {
    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let found = objects.first as? AVMetadataMachineReadableCodeObject,
            found.type == .qr,
            let text = found.stringValue,
            !text.isEmpty
        else { return }

        // A short buzz, because the camera view closing is the only other
        // signal and it is easy to miss while looking at the other device.
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)

        answer(text)
    }
}
