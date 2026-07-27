# Reaper on iOS

What works, what does not, and what the remaining work actually involves.

## Building it from Windows

Xcode is macOS-only. There is no cross-compiler, no Wine path, and no supported
way to produce an IPA on Windows — so the compile happens on a hosted Mac and
the rest is arranged to make that invisible.

```
build-ios.bat            build on a Mac, download build\Reaper-unsigned.ipa
build-ios.bat status     what the last few builds did
build-ios.bat test       run the shim tests here, in seconds, no Mac involved
```

`build-ios.bat` runs the shim tests before it starts a remote build, because
those are the tests that decide whether a phone can talk to a desktop at all
and they cost five seconds rather than twenty minutes.

### Setting it up, once

**One repository, containing both trees.** Not `for-ios-p2p` on its own. The
iOS build compiles the *same* core files as the desktop build rather than a
copy of them —

```
src/shim/core-entry.ts  ->  ../../../for-desktop-p2p/src/p2p/
```

— so a checkout containing only this folder cannot build. Sharing the core by
reference is the point of the port; it means the two travel together.

1. **Make the repository.** On GitHub, New repository → private → do not add a
   README or a licence, since there is already history to push into it.

2. **Push the whole tree.** From `stoatsrc`, not from inside a subfolder:

   ```
   git init
   git add .
   git commit -m "Reaper: desktop and iOS"
   git branch -M main
   git remote add origin https://github.com/<you>/reaper.git
   git push -u origin main
   ```

   `for-desktop-p2p` is already a git repository pointing at the *upstream*
   Stoat project, which is not yours to push to. Either remove its `.git` first
   so the parent takes it over, or point it at your own remote — but do not
   leave it aimed upstream and expect a push to work.

3. **Add it to Codemagic.** codemagic.io → Add application → connect GitHub →
   pick the repository. It reads `codemagic.yaml` from the root, which is where
   the real one lives; the copy inside `for-ios-p2p` is a signpost saying so.

4. **Now the app id exists.** Open the application in Codemagic and look at the
   address bar:

   ```
   https://codemagic.io/app/68f3a1c4d9e2b7005a1f2c3d/...
                            ^^^^^^^^^^^^^^^^^^^^^^^^
   ```

   That is `CM_APP_ID`. It is a Codemagic identifier and has nothing to do with
   an Apple bundle id or an App Store record — it does not exist until the
   repository has been added, which is why this step is last.

5. **Get a token.** Codemagic → your avatar → Teams → Personal Account →
   Integrations → Codemagic API → generate. That is `CM_API_TOKEN`.

6. **Tell Windows**, then open a *new* terminal — `setx` only affects terminals
   started afterwards:

   ```
   setx CM_API_TOKEN "..."
   setx CM_APP_ID "..."
   ```

Then `build-ios.bat` works end to end.

### Getting it onto the phone

The IPA is unsigned on purpose. Signing on a build service means uploading an
Apple ID and its certificates to somebody else's machine; Sideloadly and
AltStore re-sign on your own machine with your own free Apple ID, which keeps
the key where it belongs.

1. Install [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io).
2. Plug the phone in, drag the IPA across, sign in with an Apple ID.
3. On the phone: Settings → General → VPN & Device Management → trust the
   developer profile.

With a free Apple ID the signature lasts **seven days**, after which the app
stops opening until it is installed again. AltStore refreshes it over Wi-Fi on
its own if both devices are on the same network. A paid developer account
raises that to a year, and `codemagic.yaml` has the signed-build configuration
commented at the bottom.

## Staying alive in the background

This is the part that makes a peer-to-peer chat app possible on iOS at all.

Reaper has no server. A message arrives because a peer opened a socket to this
device, which means the app has to be running and listening — and iOS suspends
an app a few seconds after it leaves the foreground, closing every socket it
held. The usual answer is a push notification, and that needs APNs: a
permanently online third party that learns who is messaging whom, which is the
one thing this design refuses.

So the app keeps itself running. iOS grants indefinite background execution to
apps playing audio and does not check that the audio is interesting.
`plugins/keepalive` holds an `AVAudioSession` open in `.playback` with
`.mixWithOthers`, looping a buffer of true digital silence.

Both halves of that category matter. `.playback` is what earns background
execution — `.ambient` does not. `.mixWithOthers` means Reaper does not become
the "now playing" app: nothing else is paused, nothing is ducked, and the lock
screen controls are not handed to an app playing nothing. `.duckOthers` is
deliberately absent, since it would quieten other audio to make room for ours,
and ours is nothing.

The buffer is real silence rather than a very quiet tone. A tone is sometimes
recommended on the theory that iOS discards silent buffers, which has not been
true for a long time — and an inaudible tone is still a tone, showing up on a
spectrogram and through anyone's hearing aid.

### What it does not achieve

Worth being straight about, because the difference matters the first time a
message does not arrive:

- **Memory pressure still wins.** iOS terminates background apps when the
  foreground needs room. Audio raises priority; it does not exempt.
- **A reboot ends it.** Nothing restarts the app until it is opened.
- **Force-quitting ends it**, and iOS treats that as a decision.
- **The App Store forbids it.** Review guideline 2.5.4 requires background
  audio to exist for the user's benefit. This is built for sideloading.

Reachability is therefore "usually", not "always" — which is still the
difference between a chat app and a thing that only works while you look at it.

## The core, ported

The Reaper core is shared with the desktop build rather than forked. The same
`events.ts`, `identity.ts`, `crypto.ts`, `store.ts` and `transport.ts` files are
compiled here, with Node's builtins substituted at the bundler level — see the
aliases in `vite.config.ts`, mirrored in `scripts/shim.mjs` for the tests.

| Node | Replaced with | Notes |
|---|---|---|
| `node:crypto` | `@noble/*` | Synchronous, which WebCrypto is not |
| `node:zlib` | `brotli-wasm` | The reference encoder, so frames match |
| `node:fs` | in-memory + Capacitor | Synchronous reads, debounced writes |
| `node:path` | POSIX only | These are keys in a virtual tree |
| `node:net` | `plugins/socket` | Network.framework, SOCKS5 to Tor |
| `node:events` | a small emitter | Only what the transport uses |
| `electron` | `shim/electron.ts` | So the desktop bridge runs unchanged |
| the `tor` daemon | `plugins/tor` | Tor.framework, linked in rather than spawned |

### Why not WebCrypto

`crypto.subtle` is the obvious choice and it is the wrong one, for a reason
that has nothing to do with the algorithms: **every method on it is async.**

The core is synchronous throughout — `eventId()` hashes, `createEvent()` signs,
`verifyEvent()` verifies, and all three are ordinary calls used inside `filter`,
inside sort comparators, inside a loop replaying ten thousand events. Making
them async would mean rewriting the event model, the store, the transport and
the reconciliation loop on *both* platforms, so the desktop build would pay for
a constraint that exists only here.

The audited pure-JS implementations are synchronous and fast enough: verifying
a signed event costs roughly 0.3 ms on an A15, so a cold replay of ten thousand
is about three seconds behind a loading state, once.

### The tests that matter

`npm run shim:test` — 125 checks, and none of them check the shim against
itself. That would prove nothing: two incompatible implementations both pass
that test.

Every case crosses the boundary. Node signs and the shim verifies. The shim
seals and Node opens. Node writes a key and the shim reads it back.
`core.test.ts` goes further and compiles the *actual* Reaper core twice — once
against Node's builtins, once against the shims — then makes the two exchange
signed events, derive a shared conversation key, sort a conversation and
reconcile watermarks.

The reason for that machinery: every bug it catches produces an app that works
perfectly on its own and cannot exchange a message with a desktop. An event id
computed differently means neither device believes it has the other's events
and reconciliation never terminates. A signature scheme that disagrees means
every incoming event is discarded as forged. Both look, from the inside,
exactly like a network problem.

## What is not done

### ~~Tor~~ — done, needs a device to confirm

`plugins/tor` embeds [Tor.framework](https://github.com/iCepa/Tor.framework)
(`pod 'Tor/GeoIP', '~> 409.11'`) — tor, libevent, OpenSSL and liblzma compiled
for iOS and driven through a control port. The desktop build runs `tor` as a
subprocess; iOS has no `fork` and forbids shipping a separate executable, so
linking it in is the only route.

Two halves, and the second is the one that matters:

- **Reaching out** is a SOCKS port on loopback, which `plugins/socket` already
  dials through — including passing onion addresses as names so this device
  never resolves them.
- **Being reachable** is an onion service. A phone has no routable address and
  no port anybody can open; the service is what gives it one, and it is the
  entire reason this app can work without a server.

`HiddenServiceDir` and `HiddenServicePort` are passed as *arguments* rather
than options, because tor applies the port to whichever directory preceded it
and option order is not preserved.

The private key in that directory **is** the address: lose it and every peer's
saved contact stops resolving, leak it and somebody else can answer as you. It
lives under Application Support at `0700`, excluded from iCloud backup — a key
restored onto a second device would have two of them publishing the same
address — and with file protection so it is unreadable while the device is
locked, which matters because the app keeps running in a pocket.

Startup order is load-bearing: `Socket.listen` binds a loopback port and
returns it, *then* Tor publishes a service pointing at that port. The other way
round publishes an address that resolves to a closed port, so the device looks
online to every peer and refuses all of them.

Progress is reported as events rather than awaited — `bootstrapping` with a
percentage, then `ready` (outbound works), then `published` (peers can reach
you). Those are genuinely different states and the startup screen shows them
as such, amber for the middle one. A first bootstrap can take minutes.

**Not yet confirmed on hardware.** Nothing here has run on a phone: Swift
cannot be compiled in this environment, so it is careful code against a
documented API rather than tested code. The first device run is the test.

### ~~The interface~~ — done, needs a device to confirm

The desktop client runs here, unmodified. Not a port of it — the same
`for-desktop-p2p/src/local-ui/index.html`, inlined at build time by a Vite
plugin so the two cannot drift.

What made that possible is that the desktop's `bridge.ts` reaches Electron
through exactly four things: `app.getPath`, `app.getAppPath`, `app.isPackaged`
and `ipcMain.handle`. `src/shim/electron.ts` supplies all four — handlers land
in a map instead of an IPC channel — so all seventeen hundred lines of it run
here as well. `src/bridge.ts` then generates `window.p2p` from the channel
names rather than declaring sixty methods by hand, which means anything the
interface calls is reachable by construction rather than by somebody having
remembered it.

`src/mobile.css` and `src/mobile.ts` are the phone layer, loaded only by this
build:

- The server rail and sidebar become one slide-over from the left, opened by a
  button in the top bar, closed by tapping away, swiping back, or choosing
  something in it. `translateX` rather than `display`, so it composites.
- The member list becomes a slide-over from the right.
- 44pt touch targets, which is Apple's minimum and about double the desktop's.
- Long-press synthesises `contextmenu`, so the existing menus work untouched.
- The composer sits above the keyboard via `visualViewport`, and above the home
  indicator via `env(safe-area-inset-bottom)`.
- The message input is exactly 16px, below which Safari zooms on focus and does
  not zoom back.

**Not confirmed on hardware.** It compiles and the shims pass; whether the
interface behaves once it is driving a real store is the next thing to find out.

### Voice

Voice is `MediaRecorder` producing self-contained WebM/Opus segments, decoded
with `decodeAudioData`. Safari does not support WebM in `MediaRecorder` — it
produces MP4/AAC — so a phone and a desktop in the same call would each send
something the other cannot decode.

Fixing it properly means encoding Opus explicitly rather than relying on
whatever the platform's recorder emits, which is a shared change to both builds
rather than an iOS one.

### Memory

`shim/fs.ts` holds the whole log in memory so reads can be synchronous. A
megabyte of history is a megabyte of heap, and on a phone that is a real
ceiling — a few hundred megabytes of conversation would not fit.

The proper fix is the Origin Private File System, whose `createSyncAccessHandle`
is genuinely synchronous — but only inside a Web Worker, which means moving the
core off the main thread. That is the right end state for other reasons too:
replaying ten thousand events currently blocks rendering. It is a larger change
than a shim, which is why it is written here rather than half-built.

## Order of work

1. Confirm Tor on a device — that it bootstraps, and that the onion service
   publishes and accepts a connection from the desktop build.
2. `window.p2p` over the shims, so the existing interface runs unmodified.
3. The core into a Worker, with OPFS underneath it.
4. Touch and layout.
5. Voice, as a change to both platforms rather than this one.
