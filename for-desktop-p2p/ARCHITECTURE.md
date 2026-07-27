# Stoat P2P — architecture

Serverless build of the Stoat desktop app. No VPS, no delta, no bonfire, no
MongoDB. Peers hold the whole history and reconcile directly.

This document is the map: what the design is, what is built, and what remains.

---

## Where the code lives

The Electron folder (`for-desktop-p2p/`) is a shell — window management, tray,
the `stoat://` protocol handler. It is roughly fifteen files and none of them
are about chat.

The client (`for-web-p2p/`) is where messages, channels and UI live, and it is
what gets bundled in as `client-dist`.

The P2P layer runs in the **Electron main process**, not the renderer. That is
forced rather than chosen: the renderer is a browser context served over a
custom scheme, so it has no raw sockets, no filesystem, and no stable identity
for a peer to dial. Node has all three.

```
renderer (for-web-p2p)          UI, unchanged where possible
      |  IPC
main process (for-desktop-p2p)
      |-- p2p/frames.ts         compression + encryption codec    [built]
      |-- p2p/log.ts            append-only encrypted event log   [built]
      |-- p2p/identity.ts       device keys, signing              [built]
      |-- p2p/keystore.ts       key at rest via OS keychain       [built]
      |-- p2p/events.ts         signed events, causal DAG         [built]
      |-- p2p/store.ts          per-community history + merge     [built]
      |-- p2p/bridge.ts         IPC surface for the renderer      [ ]
      |-- p2p/transport.ts      libp2p node                       [ ]
      |-- p2p/community.ts      membership, invites, PKI          [ ]
      |-- p2p/blobs.ts          content-addressed files           [ ]
      |-- p2p/voice.ts          mesh WebRTC                       [ ]
```

The single biggest lever on effort: **the renderer's data layer is swappable.**
The UI talks to `stoat.js`, which today wraps HTTP + WebSocket. Replacing that
one module with an IPC bridge leaves the entire interface — channels, message
list, composer, settings — untouched. Almost all the work below is behind that
boundary.

---

## The model

### Everything is an event

There is no authoritative state anywhere, so state is derived by replaying a
signed, append-only log. A message send, a channel creation, a nickname change,
a member join — each is an event, signed by the device that produced it.

Peers reconcile by exchanging events the other lacks. That is the entire sync
protocol in one sentence, and it is why storage is a log rather than a database
(see the long comment at the top of `p2p/log.ts`).

### Ordering

No server means no global clock. Each event carries the hashes of the events
its author had already seen, forming a DAG. That gives causal ordering — if A
happened before B, everyone agrees — while concurrent events are ordered by a
tiebreak on event hash so every peer independently reaches the same sequence.

This is the part that most often gets hand-waved and then rewritten. Two people
typing simultaneously in different network partitions is the normal case, not
an edge case.

### Identity and membership

Each device has an Ed25519 keypair; the user id is derived from the public key.
The community creator is a root of trust and signs a certificate for each
member. An invite carries the community public key plus bootstrap addresses.

Consequences worth knowing before committing to this:

- **Losing your key loses your account.** There is no server to reset against.
  Key backup is a feature, not an afterthought.
- **Removing someone is not instant.** Revocation is itself an event and only
  takes effect for peers that have received it.

---

## What breaks

Honest list, because these are load-bearing today.

| Today | Serverless |
| --- | --- |
| Voice (LiveKit SFU) | Survives as mesh WebRTC for small calls — see below. Large calls degrade. |
| GIF search (Tenor) | Gone unless the client calls Tenor directly, which leaks every search to Google. |
| Link previews (january) | Each client fetches them itself, which leaks browsing to the link's host. |
| Image thumbnails (autumn) | Must be generated on the sender's machine before sending. |
| Push notifications | Require a server by construction. The app must be running. |
| History for new devices | A peer must be online to serve it. First launch on a new machine can arrive empty. |
| Search | Local index only, over what this device has. |
| Being reachable | Both peers online, or a relay. NAT is the hard part, not the crypto. |

### Voice without a media server

An SFU solves *scale*, not connectivity. In a call of N people everyone uploads
N-1 streams unless something in the middle fans them out. For small calls that
is not a problem worth a server: five peers at ~30 kbps each is 120 kbps
upstream. Mesh WebRTC holds to roughly five or six participants, which covers
the realistic case.

So voice stays, and needs only:

- **Signalling** — SDP offers and ICE candidates, a few KB per call. Carried
  over the event log like everything else. No server.
- **STUN** — public-address discovery. Trivial; a peer can serve it.
- **TURN** — relay when hole-punching fails. A server, but the same one NAT
  traversal already needs, and it only ever sees ciphertext.

The renderer already drives WebRTC for LiveKit today. Echo cancellation, jitter
buffering, loss concealment and adaptive bitrate come with it. The work is
replacing one SFU connection with N direct peer connections, not building a
media stack.

**Do not carry audio over the file/blob layer.** It is a tempting shortcut —
audio is just chunks, and blobs already work — but every property that makes
the blob layer good makes it unusable here. Reliable ordered delivery
retransmits a lost frame and stalls everything behind it, when the correct
behaviour is to discard it and play the next one; a late audio frame has no
value, because the moment it was meant to fill has passed. Persisting to disk
and content-addressing add hundreds of milliseconds to a budget that only has
about 150 total before conversation stops working. And the per-chunk envelope
would outweigh the ~60 bytes an Opus frame actually costs.

### NAT, and what everyone else does

Two consumer machines behind routers usually cannot connect directly. This is
the hard part of the whole project — harder than the cryptography, which is
mostly library calls.

Established P2P chat clients converged on one of two answers:

**Onion routing.** Briar, Quiet and Session make every peer a Tor hidden
service. NAT stops applying, because both sides dial outbound into the network
and rendezvous inside it. Buys metadata privacy for free. Costs 1-2 seconds of
latency, a bundled Tor daemon, and any hope of usable voice.

**DHT, hole punch, relay.** Tox, Jami and Berty discover peers through a
distributed hash table, attempt a direct connection, and fall back to a relay
when that fails. Tox runs volunteer bootstrap nodes and TCP relays; Jami runs
OpenDHT with STUN and TURN; Berty uses libp2p's relays.

The important observation is what these have in common: **none of them runs on
zero infrastructure.** Every one has bootstrap nodes, relays, or several
thousand volunteer Tor servers underneath it. "Serverless" in practice means no
server that holds data or that the network depends on any single instance of —
not the absence of servers.

So this design takes the second option, which keeps voice viable:

- **Kademlia DHT** for discovery
- **AutoNAT + DCUtR** to detect the NAT and punch through it
- **Circuit Relay v2** as fallback

all from `js-libp2p`, in the main process.

The existing VPS becomes a bootstrap and relay node. It performs the two roles
that genuinely require infrastructure — introducing peers, and forwarding
ciphertext when hole punching fails — while holding no messages, no keys and no
accounts. Losing it does not lose history or break established peers; it breaks
new introductions until another bootstrap is reachable. Adding a second one
later is configuration, not architecture.

---

## Transport decision

Messaging runs over **Tor onion services**. Voice runs over **direct WebRTC**,
negotiated across that channel.

Chosen on stability. Onion services connect essentially always, because both
peers dial outbound and meet inside the network — there is no pair of friends
whose routers happen to defeat hole punching. The DHT-and-punch approach is
faster but probabilistic, and a chat client that silently fails for two
specific people is worse than one that is uniformly a little slow.

Tor's latency rules out carrying audio, so voice is the exception: peers
exchange SDP over the onion channel, then connect directly, falling back to a
relay when that fails. Voice occasionally degrading is acceptable; messaging
failing is not. This is the one place the two-transport split earns its
complexity.

## Encryption

Events are already signed (`events.ts`). Encryption sits on top of the payload.

Each channel has a symmetric key. It is wrapped to each member's device public
key and distributed as an event, and rotated whenever membership changes so a
removed member cannot read anything sent afterwards. Signatures stay outside
the ciphertext, so a peer can verify authorship and ordering without being able
to decrypt — which is what lets a relay or a non-member peer carry traffic.

MLS (RFC 9420) is the general answer to group key agreement and is deliberately
not used here. It earns its complexity at hundreds of members with untrusted
servers; at twenty friends it is a large dependency for properties this threat
model does not need.

## Feature parity

Everything becomes an event. State is what you get by replaying them.

| Feature | Events | Notes |
| --- | --- | --- |
| Server creation | `community.create` | Creator's key is the root of trust |
| Channels | `channel.create/update/delete` | |
| Roles & permissions | `role.create/update`, `role.assign` | See below |
| Friends | `friend.request/accept/remove` | Needs no shared community |
| Group chats | `group.create`, `group.member.add` | A community without roles |
| Profiles | `profile.update` | Avatar is a blob reference |
| Usernames | `username.claim` | See below |
| Voice | `voice.join/leave`, SDP exchange | Media never touches the log |

Two consequences that differ from the server build and are worth knowing before
they surprise you.

**Permissions are advisory.** Every peer replays the same log and computes the
same roles, so everyone agrees on who may do what. But nothing *prevents* a
modified client from publishing a message it has no permission to send — there
is no gatekeeper. What happens instead is that every honest client rejects that
event on arrival, so it is invisible to everyone except its author. For a
private group this is sufficient. For a public server it would not be.

**Usernames cannot be globally unique.** Uniqueness needs a registry, and a
registry is a server. What does work is uniqueness *within a community*:
`username.claim` events are ordered by the causal log, so first claim wins and
every peer independently agrees who won. Across communities, two people can
hold the same display name; the 26-character key-derived id is the actual
identity and is what the client should disambiguate on.

## Stages

Each stage leaves something that runs.

**1. Local store — done.**
Append-only log, Brotli-compressed and AES-256-GCM encrypted, split into
sealed segments. Measures 24.8x on realistic message shapes; recovers from a
write torn by a crash; rejects a wrong key rather than silently starting over.
`storage.test.ts` covers round-trip, corruption, recovery, rolling.

**2. Identity and event model.**
Device keypairs in the OS keychain via Electron `safeStorage`. Event schema,
signing, verification, the causal DAG and its tiebreak. Testable with no
network at all — two in-process logs reconciling against each other.

**3. Replace the renderer's data layer.**
IPC bridge standing in for `stoat.js`'s HTTP+WS transport. At the end of this
stage the app is a fully working single-user local chat client: real UI, real
persistence, no networking. This is the stage that proves the UI survives the
transplant, and it is worth reaching before any peer code is written.

**4. Transport.**
libp2p node, gossipsub for live events, request/response for backfill.
Two machines on a LAN first, then hole-punching, then relay fallback.

**5. Membership and invites.**
Community keypair, member certificates, invite codes carrying bootstrap
addresses. Revocation.

**6. Files.**
Chunked, content-addressed, encrypted, fetched from whichever peer has them.
Sender-side thumbnailing, since nothing else can see the plaintext.

Stages 1–3 are self-contained and verifiable offline. Stage 4 is where the
schedule stops being predictable, because NAT traversal is empirical.

---

## Reference

Quiet (`github.com/TryQuiet/quiet`) solves this exact problem: OrbitDB over
IPFS for the log, Tor for transport, a certificate chain for membership. The
useful things to take are the shapes — log-as-truth, PKI for membership,
onion services to dodge NAT — rather than the stack, which is heavy and much of
it predates libp2p's current NAT support.
