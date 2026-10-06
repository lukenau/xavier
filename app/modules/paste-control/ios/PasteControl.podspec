Pod::Spec.new do |s|
  s.name           = 'PasteControl'
  s.version        = '1.0.0'
  s.summary        = 'A system paste button that hands an image to JS without the Allow Paste prompt'
  s.description    = 'Wraps UIPasteControl (iOS 16+). The tap on the system-drawn button IS the consent, so iOS never shows the "would like to paste from" dialog.'
  s.author         = 'example'
  s.homepage       = 'https://github.com/example/hub'
  s.license        = { :type => 'MIT' }
  # The project's own floor, not UIPasteControl's. Raising it here would raise
  # it for every pod in the build; the control is guarded with #available
  # instead, and the JS side refuses to render it below iOS 16.
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/example/hub.git', :tag => "#{s.version}" }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
