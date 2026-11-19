Pod::Spec.new do |s|
  s.name           = 'SunnyWidgetCore'
  s.version        = '1.0.0'
  s.summary        = 'Shared logic for the Sunny widget and the app bridge'
  s.description    = 'Timeline decoding, card selection, press queue, credentials and the device API client used by the Sunny widget extension and the app.'
  s.license        = 'UNLICENSED'
  s.author         = 'Sunny'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.2' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks     = 'Foundation', 'Security'
  s.source_files   = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'APPLICATION_EXTENSION_API_ONLY' => 'YES'
  }
end
