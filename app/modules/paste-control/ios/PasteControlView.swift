// A system paste button.
//
// Reading the clipboard from code makes iOS ask "AGENT HUB would like to paste
// from Screenshots", every time (the user, 2026-09-30: "can you make it so i don't
// have to hit allow paste please"). No JavaScript can suppress that — it is the
// OS asking on the user's behalf. `UIPasteControl` is the way out Apple
// provides: the system draws the button and reads the pasteboard itself, so the
// tap IS the consent and no dialog appears.
//
// The control only delivers to a responder that declares what it accepts
// (`pasteConfiguration`) and implements `paste(itemProviders:)`. This view is
// that responder. A picture is still the first choice, exactly as before, and
// turns into JPEG bytes for JS; a FILE (2026-10-01, "he wants files in Hub
// chat") is the second, and is read here — inside the load callback, because the
// URL it is handed is deleted the moment that callback returns — then handed to
// JS as base64 with the name it was copied under.
//
// Nothing here reads the pasteboard on its own: no `hasStrings`-style probing
// beyond the image check that was already here, and deliberately not
// `numberOfItems`, whose documentation does not say whether it prompts.
import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

/// Matches `attachments.ts`'s own ceiling for a picked image, so a paste cannot
/// take a path the upload would refuse.
private let kJpegQuality: CGFloat = 0.8

/// hub-api's cap on one attachment (chat/platform.py MAX_MEDIA_DECODED_BYTES).
/// Checked before the file is read into memory, so a huge one is refused cheaply.
private let kMaxFileBytes = 7_000_000

class PasteControlView: ExpoView {
  private let onPasteImage = EventDispatcher()
  private let onPasteFile = EventDispatcher()
  private let onPasteError = EventDispatcher()
  private var control: UIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    // What this responder is willing to receive. Without it the control stays
    // disabled however much is on the pasteboard. `item` is the root of every
    // file type; a picture still goes the picture way (see `paste`).
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [
      UTType.image.identifier,
      UTType.png.identifier,
      UTType.jpeg.identifier,
      UTType.item.identifier,
    ])
    addControl()
  }

  private func addControl() {
    // iOS 16 is where UIPasteControl arrives. The podspec keeps the project's
    // own deployment floor rather than raising it for every pod, so the API is
    // guarded here; `available` in index.tsx keeps the view off screen below 16
    // in the first place.
    guard #available(iOS 16.0, *) else { return }
    let configuration = UIPasteControl.Configuration()
    configuration.displayMode = .iconOnly
    configuration.cornerStyle = .capsule
    // The system button follows the trait collection on its own, so it is
    // right in both themes without being told.
    // The configuration is an init argument; the target is a property. Passing
    // both to init is "extra argument 'target' in call" — which is what the
    // first cloud build said, this Swift never having seen a compiler here.
    let control = UIPasteControl(configuration: configuration)
    // `target` is `(any UIPasteConfigurationSupporting)?`, NOT `UIResponder?`.
    // Assigning a view works only because UIResponder conforms to that
    // protocol; anything else assigned here must conform too.
    control.target = self
    control.translatesAutoresizingMaskIntoConstraints = false
    addSubview(control)
    NSLayoutConstraint.activate([
      control.leadingAnchor.constraint(equalTo: leadingAnchor),
      control.trailingAnchor.constraint(equalTo: trailingAnchor),
      control.topAnchor.constraint(equalTo: topAnchor),
      control.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    self.control = control
  }

  /// UIKit calls this when the button is tapped and the pasteboard holds
  /// something this view accepts. It is the only path — the app never reads the
  /// pasteboard itself, which is exactly why there is no prompt.
  override func paste(itemProviders: [NSItemProvider]) {
    if let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: UIImage.self) }) {
      pasteImage(provider)
      return
    }
    if let provider = itemProviders.first(where: { isFile($0) }) {
      pasteFile(provider)
      return
    }
    onPasteError(["reason": "not_pasteable"])
  }

  private func pasteImage(_ provider: NSItemProvider) {
    provider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
      guard let self else { return }
      guard let image = object as? UIImage, error == nil else {
        DispatchQueue.main.async { self.onPasteError(["reason": "unreadable"]) }
        return
      }
      guard let data = image.jpegData(compressionQuality: kJpegQuality) else {
        DispatchQueue.main.async { self.onPasteError(["reason": "unreadable"]) }
        return
      }
      // Base64 on a background queue: a screenshot is a megabyte or two and
      // this runs on the provider's callback thread, not the main one.
      let base64 = data.base64EncodedString()
      DispatchQueue.main.async {
        self.onPasteImage([
          "base64": base64,
          "mime": "image/jpeg",
          "width": Int(image.size.width * image.scale),
          "height": Int(image.size.height * image.scale),
        ])
      }
    }
  }

  /// A file is something with a name on disk. Plain text copied out of an app has
  /// none, so it is not mistaken for one — `item` is also the root of text, which
  /// is why the pasteboard type alone cannot decide this.
  private func isFile(_ provider: NSItemProvider) -> Bool {
    provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
      || (provider.suggestedName != nil && provider.hasItemConformingToTypeIdentifier(UTType.item.identifier))
  }

  /// The representation to load the file's CONTENT from: the first registered
  /// type that is data and is not the file-url (which would give back the URL's
  /// own text, not the file).
  private func dataTypeIdentifier(for provider: NSItemProvider) -> String {
    for id in provider.registeredTypeIdentifiers {
      if id == UTType.fileURL.identifier { continue }
      if let type = UTType(id), type.conforms(to: .data) { return id }
    }
    return UTType.data.identifier
  }

  private func pasteFile(_ provider: NSItemProvider) {
    let typeIdentifier = dataTypeIdentifier(for: provider)
    let type = UTType(typeIdentifier)
    let suggested = provider.suggestedName
    _ = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
      guard let self else { return }
      // The URL is deleted when this closure returns, so everything that needs
      // the file has to happen in here.
      guard let url, error == nil else {
        DispatchQueue.main.async { self.onPasteError(["reason": "unreadable"]) }
        return
      }
      if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > kMaxFileBytes {
        DispatchQueue.main.async { self.onPasteError(["reason": "too_big"]) }
        return
      }
      guard let data = try? Data(contentsOf: url) else {
        DispatchQueue.main.async { self.onPasteError(["reason": "unreadable"]) }
        return
      }
      if data.count > kMaxFileBytes {
        DispatchQueue.main.async { self.onPasteError(["reason": "too_big"]) }
        return
      }
      let name = PasteControlView.fileName(suggested: suggested, fallback: url.lastPathComponent, type: type)
      let mime = type?.preferredMIMEType ?? "application/octet-stream"
      let base64 = data.base64EncodedString()
      DispatchQueue.main.async {
        self.onPasteFile(["base64": base64, "mime": mime, "name": name])
      }
    }
  }

  /// The name a pasted file goes up under: the one it was copied as, with an
  /// extension if it has none, so "report" from a share sheet is "report.pdf".
  private static func fileName(suggested: String?, fallback: String, type: UTType?) -> String {
    let base = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    if URL(fileURLWithPath: base).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension {
      return base + "." + ext
    }
    return base
  }

  /// A responder must say yes to `paste:` for the control to enable itself.
  /// A picture on the pasteboard still says yes at once; for anything else the
  /// answer is UIKit's own, which weighs the pasteboard against `pasteConfiguration`
  /// without ever showing the app what is on it.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(UIResponder.paste(_:)) {
      return UIPasteboard.general.hasImages || super.canPerformAction(action, withSender: sender)
    }
    return super.canPerformAction(action, withSender: sender)
  }
}
