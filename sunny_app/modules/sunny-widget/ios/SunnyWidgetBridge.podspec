Pod::Spec.new do |s|
  s.name           = 'SunnyWidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'Bridge from the Sunny app to its widget'
  s.description    = 'Stores and clears the widget credentials, replays queued presses and reloads widget timelines.'
  s.license        = 'UNLICENSED'
  s.author         = 'Sunny'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.2' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks     = 'WidgetKit'
  s.dependency 'ExpoModulesCore'
  s.dependency 'SunnyWidgetCore'
  s.source_files   = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
