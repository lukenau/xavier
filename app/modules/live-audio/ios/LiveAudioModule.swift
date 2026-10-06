// Live voice audio on ONE AVAudioEngine with Apple voice processing (echo
// cancellation), following Apple's "Using voice processing" sample
// (AVEchoTouch, WWDC19 session 510) step for step:
//
//   1. one engine for the module's lifetime; player nodes attached once;
//   2. voice processing enabled on the input node while the engine is STOPPED
//      and BEFORE any connection is made ("voice processing cannot be enabled
//      dynamically… the engine needs to be in a stop state");
//   3. one mono 24 kHz format for the playback path. The input is tapped in
//      the node's OWN format and converted (voice processing can report a
//      multi-channel input at the hardware rate on newer iPhones; a tap
//      format the node cannot produce is an exception, i.e. a crash);
//   4. on AVAudioEngineConfigurationChange, restart the SAME engine if it
//      stopped. Never rebuild it: a rebuilt engine has voice processing off,
//      re-enabling it reconfigures the route again, and that loop leaves the
//      mic deaf, the UI frozen and the app eventually crashing. This is why
//      voice processing is not bolted onto react-native-audio-api, which
//      rebuilds its engine on every configuration change.
//
// Audio crosses to JS as base64 16-bit PCM (24 kHz mono both ways). Every
// state change is reported on `onDiag`, so device behaviour shows up in the
// server's Live log without a debugger attached.
import AVFoundation
import ExpoModulesCore

private struct LiveAudioError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

public class LiveAudioModule: Module {
  private static let sampleRate: Double = 24000
  /// 80 ms at 24 kHz — the frame Deepgram Flux recommends.
  private static let frameSamples = 1920

  private let engine = AVAudioEngine()
  private let speech = AVAudioPlayerNode()
  private let tones = AVAudioPlayerNode()
  private var ioFormat: AVAudioFormat?
  private var configured = false
  private var active = false
  private var converter: AVAudioConverter?
  private var pending: [Int16] = []
  private let pendingLock = NSLock()
  private var observers: [NSObjectProtocol] = []
  private var restarts: [Date] = []

  public func definition() -> ModuleDefinition {
    Name("LiveAudio")

    Events("onFrame", "onPlayed", "onDiag", "onInterruption")

    AsyncFunction("requestPermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        promise.resolve(granted)
      }
    }

    AsyncFunction("start") { () throws -> [String: Any] in
      try self.start()
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stop()
    }.runOnQueue(.main)

    // One chunk of the reply: 16-bit PCM, 24 kHz mono. `tag` (the reply's turn
    // id) comes back on `onPlayed` when that chunk has actually been heard.
    // enqueue / playTone / clear hop to main so they stay in order with each
    // other and never race the engine stopping on a configuration change.
    Function("enqueue") { (pcmBase64: String, tag: Int) in
      DispatchQueue.main.async { self.schedule(pcmBase64, on: self.speech, tag: tag) }
    }

    // Earcons go through the same engine, so voice processing removes them
    // from the mic too (and they are not ducked as "other audio").
    Function("playTone") { (pcmBase64: String) in
      DispatchQueue.main.async { self.schedule(pcmBase64, on: self.tones, tag: -1) }
    }

    Function("clear") {
      DispatchQueue.main.async {
        self.speech.stop()
        if self.active && self.engine.isRunning {
          self.speech.play()
        }
      }
    }

    Function("setDucked") { (ducked: Bool) in
      self.speech.volume = ducked ? 0.2 : 1.0
    }

    OnDestroy {
      self.stop()
      for observer in self.observers {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observers.removeAll()
    }
  }

  // MARK: - Lifecycle

  private func start() throws -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    // Apple's sample sets only defaultToSpeaker: voice chat implies Bluetooth
    // HFP, and every extra option is another way for iOS to renegotiate the
    // route.
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
    try session.setActive(true)

    if !configured {
      try configure()
    }

    pendingLock.lock()
    pending.removeAll()
    pendingLock.unlock()

    active = true
    if !engine.isRunning {
      try engine.start()
    }
    speech.play()
    tones.play()

    let input = engine.inputNode
    // The port's kind (MicrophoneBuiltIn, BluetoothHFP…), not its name: a
    // Bluetooth device's name is often its owner's, and this goes to the log.
    let route = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
    let info: [String: Any] = [
      "voiceProcessing": input.isVoiceProcessingEnabled,
      "inputFormat": "\(input.outputFormat(forBus: 0))",
      "route": route,
      "sampleRate": LiveAudioModule.sampleRate,
    ]
    diag("started voiceProcessing=\(input.isVoiceProcessingEnabled) route=\(route) input=\(input.outputFormat(forBus: 0))")
    return info
  }

  private func configure() throws {
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: LiveAudioModule.sampleRate,
      channels: 1,
      interleaved: false
    ) else {
      throw LiveAudioError(message: "could not create the 24 kHz mono format")
    }
    ioFormat = format

    // A failed configure is retried on the next start; attaching twice raises.
    if speech.engine == nil { engine.attach(speech) }
    if tones.engine == nil { engine.attach(tones) }

    // Engine stopped, nothing connected yet: the only state Apple supports.
    try engine.inputNode.setVoiceProcessingEnabled(true)

    let mixer = engine.mainMixerNode
    engine.connect(speech, to: mixer, format: format)
    engine.connect(tones, to: mixer, format: format)
    engine.connect(mixer, to: engine.outputNode, format: format)

    engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, _ in
      self?.capture(buffer)
    }

    observers.append(NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.diag("engine configuration change (running=\(self.engine.isRunning))")
      self.restartIfStopped()
    })

    observers.append(NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] note in
      self?.interruption(note)
    })

    engine.prepare()
    configured = true
  }

  private func stop() {
    active = false
    speech.stop()
    tones.stop()
    if engine.isRunning {
      engine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    diag("stopped")
  }

  /// Apple's configuration-change handling: the same engine, started again.
  private func restartIfStopped() {
    guard active, !engine.isRunning else { return }
    // Never more than a handful in a burst: a restart loop freezes the app,
    // and a dead mic with a notice beats a frozen app.
    let now = Date()
    restarts = restarts.filter { now.timeIntervalSince($0) < 10 } + [now]
    if restarts.count > 5 {
      diag("restart storm: giving up")
      return
    }
    do {
      try engine.start()
      speech.play()
      tones.play()
      diag("engine restarted (same engine, voiceProcessing=\(engine.inputNode.isVoiceProcessingEnabled))")
    } catch {
      diag("engine restart failed: \(error.localizedDescription)")
    }
  }

  private func interruption(_ note: Notification) {
    // Observers outlive a session; a call ending while Live is off must not
    // take the audio session back from whatever else is playing.
    guard active else { return }
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    if type == .began {
      sendEvent("onInterruption", ["type": "began"])
    } else {
      try? AVAudioSession.sharedInstance().setActive(true)
      restartIfStopped()
      sendEvent("onInterruption", ["type": "ended"])
    }
  }

  // MARK: - Audio

  /// Tap thread. Converts whatever the input delivers to 24 kHz mono Int16
  /// and cuts it into 80 ms frames.
  private func capture(_ buffer: AVAudioPCMBuffer) {
    guard active, let samples = convert(buffer) else { return }
    var frames: [[Int16]] = []

    pendingLock.lock()
    pending.append(contentsOf: samples)
    while pending.count >= LiveAudioModule.frameSamples {
      frames.append(Array(pending[0..<LiveAudioModule.frameSamples]))
      pending.removeFirst(LiveAudioModule.frameSamples)
    }
    pendingLock.unlock()

    for frame in frames {
      var sum: Float = 0
      for value in frame {
        let f = Float(value) / 32768
        sum += f * f
      }
      let level = (sum / Float(frame.count)).squareRoot()
      let data = frame.withUnsafeBufferPointer { Data(buffer: $0) }
      sendEvent("onFrame", ["pcm": data.base64EncodedString(), "level": level])
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) -> [Int16]? {
    if converter == nil || converter?.inputFormat != buffer.format {
      guard let out = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: LiveAudioModule.sampleRate,
        channels: 1,
        interleaved: true
      ), let made = AVAudioConverter(from: buffer.format, to: out) else { return nil }
      // Channel 0 is the processed voice; mixing in the others would add
      // back what voice processing removed.
      if buffer.format.channelCount > 1 {
        made.channelMap = [0]
      }
      converter = made
      diag("mic format \(buffer.format)")
    }
    guard let converter = converter else { return nil }
    let ratio = LiveAudioModule.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let data = out.int16ChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: data, count: Int(out.frameLength)))
  }

  private func schedule(_ pcmBase64: String, on player: AVAudioPlayerNode, tag: Int) {
    guard active, let format = ioFormat,
          let data = Data(base64Encoded: pcmBase64),
          data.count >= 2 else { return }
    let frames = data.count / 2
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let out = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for i in 0..<frames {
        let lo = UInt16(raw[2 * i])
        let hi = UInt16(raw[2 * i + 1])
        out[i] = Float(Int16(bitPattern: lo | (hi << 8))) / 32768
      }
    }
    let ms = Double(frames) / LiveAudioModule.sampleRate * 1000
    player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
      if tag >= 0 {
        self?.sendEvent("onPlayed", ["tag": tag, "ms": ms])
      }
    }
  }

  private func diag(_ message: String) {
    sendEvent("onDiag", ["message": message])
  }
}
