Pod::Spec.new do |s|
  s.name = 'PaseoTextSelection'
  s.version = '0.1.0'
  s.summary = 'Timeline text selection actions'
  s.description = 'Scoped native text selection actions for Paseo'
  s.license = 'Apache-2.0'
  s.author = 'Paseo'
  s.homepage = 'https://paseo.sh'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.4'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
