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
  # iOS.
  #
  # The root spec rather than `Tor/GeoIP`. The country database is only used
  # for country-based node selection — circuits and onion services do not need
  # it — and the subspec adds a build phase that downloads the files plus an
  # `NSBundle` category whose Swift name could not be verified from here. Left
  # out rather than guessed at on the critical path; it can be added once there
  # is a device to check it against.
  s.dependency 'Tor', '~> 409.11'

  s.swift_version = '5.1'
end
