Pod::Spec.new do |s|
  s.name           = 'SunnyLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'ActivityKit side of the Sunny Live Activity'
  s.description    = 'Reads and changes the Sunny Live Activities on the phone and reports their push tokens. Used by the app and by the widget extension.'
  s.license        = 'UNLICENSED'
  s.author         = 'Sunny'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.2' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks     = 'ActivityKit', 'WidgetKit'
  s.dependency 'SunnyWidgetCore'
  s.source_files   = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'APPLICATION_EXTENSION_API_ONLY' => 'YES'
  }
end
