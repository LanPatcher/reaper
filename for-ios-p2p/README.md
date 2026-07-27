# Reaper for iOS

Serverless, end-to-end encrypted chat over Tor. Same core as the desktop build —
literally the same files, compiled with Node's builtins substituted rather than
forked.

## Quick start, on Windows

```
npm install
build-ios.bat test       run the shim tests here, in seconds
build-ios.bat            build on a hosted Mac, download the IPA
```

The compile happens on a Mac because Xcode is macOS-only and there is no
cross-compiler. `build-ios.bat` starts that build, follows it, and puts
`Reaper-unsigned.ipa` in `build\`. It needs `CM_API_TOKEN` and `CM_APP_ID` set
once — [docs/ios-port.md](docs/ios-port.md) has the whole setup.

**This folder is not a repository on its own.** It compiles the same core files
as the desktop build by reference — `src/shim/core-entry.ts` imports from
`../../../for-desktop-p2p/src/p2p/` — so push the parent directory containing
both trees. The build configuration lives at that root, for the same reason.

Install the IPA with [Sideloadly](https://sideloadly.io) or
[AltStore](https://altstore.io), which re-sign on your own machine with your own
Apple ID. With a free account the signature lasts seven days.

## What is here

```
src/shim/          node:crypto, node:zlib, node:fs and node:path for a WebView
src/boot.ts        startup, in the order the pieces depend on each other
plugins/keepalive  the silent audio session that stops iOS suspending the app
plugins/socket     TCP over Network.framework, dialled through SOCKS5 to Tor
codemagic.yaml     the macOS build
scripts/           the shim tests, and the Windows-to-IPA pipeline
docs/ios-port.md   what works, what does not, and what the rest involves
```

## Staying alive in the background

The thing that makes a peer-to-peer chat app possible on iOS at all. There is no
server, so a message arrives because a peer opened a socket to this device — and
iOS suspends an app seconds after it leaves the foreground. Push notifications
would solve it and would mean routing through APNs, which is precisely the
always-on third party this design refuses.

So the app holds an audio session open playing silence. `.playback` earns the
background execution; `.mixWithOthers` means nothing else is paused, ducked, or
handed the lock screen controls. It makes no sound and interrupts nothing.

It is not unconditional: memory pressure still terminates the app, a reboot ends
it, and force-quitting ends it. Reachability is "usually", not "always".

The App Store forbids this under review guideline 2.5.4. This build is for
sideloading, which is what that choice buys.

## Tests

```
npm run shim:test
```

125 checks, none of which compare the shim to itself — two incompatible
implementations would both pass that. Every case crosses the boundary: Node
signs and the shim verifies, the shim seals and Node opens, the shim compresses
and Node decompresses. `core.test.ts` compiles the real Reaper core twice, once
against Node's builtins and once against the shims, and makes the two exchange
signed events.

Run them before every remote build. `build-ios.bat` does it automatically, since
they cost five seconds and a Mac build costs twenty minutes.

## Status

Working: identity, event log, signatures, encryption, compression, storage,
version-vector reconciliation — all verified byte-identical to the desktop.
Background execution.

Not yet: Tor, the interface, and voice. See
[docs/ios-port.md](docs/ios-port.md), which is specific about each.
