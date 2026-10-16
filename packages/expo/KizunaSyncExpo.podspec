require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
engine_package_path = ENV.fetch('KIZUNASYNC_SWIFT_PACKAGE_PATH', '')
source_root = File.directory?(File.join(__dir__, 'expo/ios')) ? 'expo/ios' : 'ios'

Pod::Spec.new do |s|
  s.name = 'KizunaSyncExpo'
  s.version = package['version']
  s.summary = 'Expo Modules API 2.0 host for the Kizuna Turso engine'
  s.homepage = 'https://github.com/kizunasync/kizunasync'
  s.license = 'Apache-2.0'
  s.authors = 'KizunaSync'
  s.source = { :git => 'https://github.com/kizunasync/kizunasync.git', :tag => "v#{s.version}" }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = "#{source_root}/**/*.swift"
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }

  unless respond_to?(:spm_dependency, true)
    raise 'KizunaSyncExpo requires React Native Podfile helpers (spm_dependency). Run pod install from the Expo app ios directory.'
  end
  spm_dependency(s,
    url: engine_package_path.empty? ? 'https://github.com/kizunasync/kizunasync-swift' : engine_package_path,
    requirement: { kind: 'exactVersion', version: package['version'] },
    products: ['KizunaSyncFfi']
  )
end
