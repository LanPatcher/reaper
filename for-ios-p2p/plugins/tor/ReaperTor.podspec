require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ReaperTor'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'AGPL-3.0'
  s.homepage = 'https://github.com/reaper'
  s.author = 'Ray'
  s.source = { :git => '.', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'

  # Tor.framework is built for iOS 12 and later, which is above Capacitor's
  # own floor — so this raises the deployment target for the whole app.
  s.ios.deployment_target = '14.0'

  s.dependency 'Capacitor'

  # The embedded Tor client: tor, libevent, OpenSSL and liblzma compiled for
  # iOS. `GeoIP` rather than the root spec because Tor needs the country
  # database to pick entry guards sensibly, and the subspec installs it as a
  # bundle with a build phase that fetches the current files.
  s.dependency 'Tor/GeoIP', '~> 409.11'

  s.swift_version = '5.1'
end
