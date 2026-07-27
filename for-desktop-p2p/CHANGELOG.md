# Changelog

## Unreleased

### Renamed to Reaper

The product, the window, the tray, the installer, the update feed, the data
directory, the startup entry and the `stoat://` scheme the client is served
over. Three things were deliberately *not* renamed, because renaming them would
break something silently:

* **The key-derivation label** (`mayhem-e2ee-v1`). It is an HKDF input, so
  changing it changes every derived key — a renamed client could not read a
  single existing direct message.
* **The identity export marker.** Files written before the rename still import;
  a backup that stops working on the day the app is renamed is not a backup.
* **The server export marker**, for the same reason — invites already handed
  out keep working.

Data is carried across automatically. Electron derives its storage directory
from the product name, so a rename silently points the app at an empty one —
which presents as being asked to choose a username again with all history gone.
The migration now walks a list of previous names rather than one, so a device
upgrading straight from the Stoat fork still finds its identity.

Windows packages are named Reaper, so Squirrel will not treat the first release
as an update to an installed Mayhem build — it has to be installed over the top
once. The old auto-launch entry is removed on first run and the setting carried
over, rather than leaving a startup item pointing at an executable that no
longer exists.

### Features

* Logs are described to peers by watermark instead of by listing every event id.
  A community with ten thousand events used to announce itself in roughly 645 KB
  of incompressible hashes on every connection; it is now two numbers. Peers that
  do not understand the compact form are still sent the full list, so nothing
  written before this keeps working unchanged.
* Desktop notifications for messages arriving in a conversation you are not
  watching, and clicking one brings the window back and opens that conversation.
  They carry who wrote and where, never the message: Windows keeps notifications
  in the Action Centre, where they outlive the app and are readable by anyone at
  the machine.
* Start with Windows, start hidden in the tray, and close-to-tray, all reachable
  from settings.
* A storage sweep that deletes downloaded files over the size limit that were not
  sent from this device. Files you sent are never touched.
* Optional view-driven loading: files above the limit are fetched when scrolled
  to and released once well out of view.
* `npm run release` stages an installer and update feed that can be served from
  any static host, so releases no longer depend on GitHub.

### Bug Fixes

* Exporting an identity always failed with `error:030000AC:digital envelope
  routines::memory limit exceeded`. Scrypt needs `128 * N * r` bytes, which at
  the chosen parameters is exactly 33,554,432 — exactly Node's default ceiling,
  and Node requires the requirement to be *below* the ceiling rather than at it.
  The budget is now declared explicitly instead of weakening the parameters to
  fit under a default nobody had written down.
* The storage sweep cleared nothing and the single-file delete would have
  deleted the wrong things. Both read `payload.files` off the raw event, but
  `message.send` is sealed whenever the community has a key — so the payload is
  `{ e: 1, n, c, t }` and `files` is simply absent. The sweep therefore found
  nothing, and the delete concluded that no file had ever been sent from this
  device, which is the dangerous direction: it would have removed the only copy.
* Files are no longer deleted when nobody who has them is reachable. Deleting a
  file is only reclaiming space while somebody can send it back; otherwise it is
  losing it. The sweep reports what it kept and why, and deleting a specific
  file by hand warns before overriding — which is the one path allowed to.
* View-driven loading never cleared anything: the distance at which a file
  counted as out of view was larger than the whole windowed channel renders, so
  nothing ever reached it.
* Lowering the attachment size limit no longer hides attachments already on disk.
  The limit governs what is fetched, not what is shown.
* Reclaiming space left the event log closed, so the first message sent after it
  threw and the store stayed unusable until restart.
* Auto-launch registered itself as "Stoat" and its IPC handlers were tree-shaken
  out of the build entirely, so the setting could not have worked.

## [1.4.2](https://github.com/stoatchat/for-desktop/compare/v1.4.1...v1.4.2) (2026-07-17)


### Bug Fixes

* Don't send audio as undefined and instead omit it ([#241](https://github.com/stoatchat/for-desktop/issues/241)) ([dc20b6e](https://github.com/stoatchat/for-desktop/commit/dc20b6e232e184ce1053cfdc7b83550e69ea285a))

## [1.4.1](https://github.com/stoatchat/for-desktop/compare/v1.4.0...v1.4.1) (2026-07-16)


### Bug Fixes

* Do not enable autostart on first launch ([#237](https://github.com/stoatchat/for-desktop/issues/237)) ([e00f3a8](https://github.com/stoatchat/for-desktop/commit/e00f3a860c566ea1e8287573144c2e081d243664))
* make electron use loopback instead of loopbackwithmute ([#236](https://github.com/stoatchat/for-desktop/issues/236)) ([1940938](https://github.com/stoatchat/for-desktop/commit/1940938850d9bf7d4821554dc2dbde96a9f94b8c))

## [1.4.0](https://github.com/stoatchat/for-desktop/compare/v1.3.0...v1.4.0) (2026-06-16)


### Features

* enable screen sharing and integrate screen picker ([#207](https://github.com/stoatchat/for-desktop/issues/207)) ([c9d59ee](https://github.com/stoatchat/for-desktop/commit/c9d59ee044724cec86bc6a286ef1e34accf8c560))


### Bug Fixes

* **flatpak:** change screenshot path into an url in the metainfo file ([#195](https://github.com/stoatchat/for-desktop/issues/195)) ([74c941e](https://github.com/stoatchat/for-desktop/commit/74c941e5b83cd14ddecb74150d5a1d08c143278b))

## [1.3.0](https://github.com/stoatchat/for-desktop/compare/v1.2.0...v1.3.0) (2026-02-18)


### Features

* minimise-to-tray-on-startup ([#126](https://github.com/stoatchat/for-desktop/issues/126)) ([8284117](https://github.com/stoatchat/for-desktop/commit/8284117e76c0fcff4091de3ef623014e4594a593))
* Reload/Refresh shortcut ([#119](https://github.com/stoatchat/for-desktop/issues/119)) ([2e99b19](https://github.com/stoatchat/for-desktop/commit/2e99b19353fbd45d9fdf1d148bae3a8a19c788ed))


### Bug Fixes

* Add common zoom-reset shortcut. ([#112](https://github.com/stoatchat/for-desktop/issues/112)) ([def29f9](https://github.com/stoatchat/for-desktop/commit/def29f9b3c1205944aab58beb8000815d41633b5))
* allow CTRL+"+" to also zoom in. ([#108](https://github.com/stoatchat/for-desktop/issues/108)) ([2b962c5](https://github.com/stoatchat/for-desktop/commit/2b962c5d066787601223368ee7dcc1e46a345b8a))
* App-maximized-2nd-monitor ([897d706](https://github.com/stoatchat/for-desktop/commit/897d706983a347938a2fb42ba8e58e40794bba13))
* don't re-enable abutostart ([63b9ea8](https://github.com/stoatchat/for-desktop/commit/63b9ea818a9f32ca8535948e18752726c0f50a12))
* firstLaunch = false after initial setup ([#131](https://github.com/stoatchat/for-desktop/issues/131)) ([63b9ea8](https://github.com/stoatchat/for-desktop/commit/63b9ea818a9f32ca8535948e18752726c0f50a12))
* flatpak icons not building correctly and wayland support ([#132](https://github.com/stoatchat/for-desktop/issues/132)) ([ffe17ec](https://github.com/stoatchat/for-desktop/commit/ffe17ec2c54fca6967435b8a4ada7fa8d4da7b33))
* replace default dialog with notification ([#98](https://github.com/stoatchat/for-desktop/issues/98)) ([7d2f296](https://github.com/stoatchat/for-desktop/commit/7d2f296ca72bbd7ad694c66a917d47067f883fc5))
* toggle window visibility on tray click instead of always showing ([#103](https://github.com/stoatchat/for-desktop/issues/103)) ([742a95f](https://github.com/stoatchat/for-desktop/commit/742a95f3cb820c5b5398c815b7b45017b6b06053))
* try to restore maximised windows to correct display ([#92](https://github.com/stoatchat/for-desktop/issues/92)) ([897d706](https://github.com/stoatchat/for-desktop/commit/897d706983a347938a2fb42ba8e58e40794bba13))
* use template icon for macOS tray, use higher res icons for other platforms ([#130](https://github.com/stoatchat/for-desktop/issues/130)) ([58ccb63](https://github.com/stoatchat/for-desktop/commit/58ccb63d23541a03e05a48a37a98f883a2ba0d3f))

## [1.2.0](https://github.com/stoatchat/for-desktop/compare/v1.1.12...v1.2.0) (2026-02-14)


### Features

* new branding ([#87](https://github.com/stoatchat/for-desktop/issues/87)) ([8910dcb](https://github.com/stoatchat/for-desktop/commit/8910dcba923b55df789c0541b59a6a6321a28768))
* persist and restore window size and position ([#74](https://github.com/stoatchat/for-desktop/issues/74)) ([3bf697d](https://github.com/stoatchat/for-desktop/commit/3bf697d1a9aba739b6954c8469223f51093497cc))


### Bug Fixes

* App Autostart ([#68](https://github.com/stoatchat/for-desktop/issues/68)) ([127d143](https://github.com/stoatchat/for-desktop/commit/127d1430a9c630e0429c9cc50d57ee316a63ebe5))

## [1.1.12](https://github.com/stoatchat/for-desktop/compare/v1.1.11...v1.1.12) (2025-12-29)


### Bug Fixes

* add NixOS compatibility for electron startup ([#23](https://github.com/stoatchat/for-desktop/issues/23)) ([3eb9b8e](https://github.com/stoatchat/for-desktop/commit/3eb9b8e84bf05debf9843b80c468911fd095f4a0))
* correctly load badge count; expose to renderer ([#25](https://github.com/stoatchat/for-desktop/issues/25)) ([6817b55](https://github.com/stoatchat/for-desktop/commit/6817b554e57c5a65b7b4aca7d1cc4e05cd6f01b7))
* event listener accumulation from rpc client ([#26](https://github.com/stoatchat/for-desktop/issues/26)) ([96fa8cc](https://github.com/stoatchat/for-desktop/commit/96fa8cc647029cb53e5d619b94debc6cdfdf32f6))
* **macos:** tray icon size ([5eecab5](https://github.com/stoatchat/for-desktop/commit/5eecab59431cb4966eaa1fc907a8e5c16c813230))
* rpc should define largeImageText ([#21](https://github.com/stoatchat/for-desktop/issues/21)) ([cb373b6](https://github.com/stoatchat/for-desktop/commit/cb373b6dc62630147151039c3711aef74c8c2d88))
* use the correct argument for auto start ([#22](https://github.com/stoatchat/for-desktop/issues/22)) ([532af4a](https://github.com/stoatchat/for-desktop/commit/532af4a680069f72734148b0ccdacec6c435e640)), closes [#20](https://github.com/stoatchat/for-desktop/issues/20)
