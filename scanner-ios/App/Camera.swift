import AVFoundation
import SwiftUI
import UIKit

/// What the camera is for: reading codes (QR for pairing, or groceries' barcodes), or taking pictures of a receipt.
enum CameraUse { case qr, barcodes, photo }

/// Takes a receipt's picture with the camera on screen.
final class PhotoTaker {
    fileprivate weak var controller: CameraController?
    func take(_ done: @escaping (UIImage?, String?) -> Void) {
        guard let c = controller else { return done(nil, "the camera isn't ready") }
        c.takePhoto(done)
    }
}

/// The camera, once it's allowed: its preview, with whatever else it's doing.
struct CameraView: View {
    let use: CameraUse
    var taker: PhotoTaker? = nil
    var found: ([String]) -> Void = { _ in }
    @State private var allowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    @State private var refused = false

    var body: some View {
        Group {
            if allowed {
                CameraPreview(use: use, taker: taker, found: found).ignoresSafeArea(edges: .top)
            } else {
                VStack {
                    Spacer()
                    Hint(refused ? "The scanner needs the camera. Allow it in Settings → Pantry scanner → Camera." : "Asking for the camera…", color: Look.ink)
                        .multilineTextAlignment(.center).padding(24)
                    if refused {
                        Btn("Open Settings", quiet: true) {
                            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                        }
                    }
                    Spacer()
                }.frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            guard !allowed else { return }
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async { allowed = ok; refused = !ok }
            }
        }
    }
}

private struct CameraPreview: UIViewControllerRepresentable {
    let use: CameraUse
    let taker: PhotoTaker?
    let found: ([String]) -> Void

    func makeUIViewController(context: Context) -> CameraController {
        let c = CameraController(use: use)
        c.found = found
        taker?.controller = c
        return c
    }
    func updateUIViewController(_ c: CameraController, context: Context) {
        c.found = found
        taker?.controller = c
    }
}

final class CameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate, AVCapturePhotoCaptureDelegate {
    let use: CameraUse
    var found: ([String]) -> Void = { _ in }
    private let session = AVCaptureSession()
    private let photos = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "pantry.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var photoDone: ((UIImage?, String?) -> Void)?

    init(use: CameraUse) { self.use = use; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer

        session.beginConfiguration()
        session.sessionPreset = use == .photo ? .photo : .high
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            session.commitConfiguration(); return
        }
        session.addInput(input)
        if use == .photo {
            if session.canAddOutput(photos) { session.addOutput(photos) }
        } else {
            let meta = AVCaptureMetadataOutput()
            if session.canAddOutput(meta) {
                session.addOutput(meta)
                meta.setMetadataObjectsDelegate(self, queue: .main)
                let want: [AVMetadataObject.ObjectType] = use == .qr ? [.qr] : [.ean13, .ean8, .upce]
                meta.metadataObjectTypes = want.filter { meta.availableMetadataObjectTypes.contains($0) }
            }
        }
        session.commitConfiguration()
        // Near things (a barcode a hand's length away) in focus.
        if camera.isAutoFocusRangeRestrictionSupported, (try? camera.lockForConfiguration()) != nil {
            camera.autoFocusRangeRestriction = .near
            camera.unlockForConfiguration()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let s = session
        queue.async { if !s.isRunning { s.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        queue.async { if s.isRunning { s.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let codes = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        if !codes.isEmpty { found(codes) }
    }

    func takePhoto(_ done: @escaping (UIImage?, String?) -> Void) {
        guard session.outputs.contains(photos) else { return done(nil, "the camera couldn't take it") }
        photoDone = done
        if let c = photos.connection(with: .video), c.isVideoOrientationSupported { c.videoOrientation = .portrait }
        photos.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let image = photo.fileDataRepresentation().flatMap { UIImage(data: $0) }
        let done = photoDone
        photoDone = nil
        DispatchQueue.main.async {
            if let image { done?(image, nil) } else { done?(nil, error?.localizedDescription ?? "the camera couldn't take it") }
        }
    }
}
