Pod::Spec.new do |s|
  s.name           = 'LiveAudio'
  s.version        = '1.0.0'
  s.summary        = 'Full-duplex voice audio for Live: Apple voice processing (echo cancellation) on one AVAudioEngine'
  s.description    = 'Follows Apple\'s "Using voice processing" sample: one engine, voice processing enabled before any connection, one mono format for playback and the input tap, same-engine restart on configuration change.'
  s.author         = 'example'
  s.homepage       = 'https://github.com/example/hub'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/example/hub.git', :tag => "#{s.version}" }
  s.static_framework = true
  # Expo's own modules pin 5.9; Swift 6 mode would turn the tap and
  # notification closures into strict-concurrency errors.
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
