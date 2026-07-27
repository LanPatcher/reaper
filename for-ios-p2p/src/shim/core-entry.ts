/**
 * The desktop core, re-exported so it can be built twice.
 *
 * This file exists only for `core.test.ts`. The runner bundles it once against
 * Node's real builtins and once against the shims, then makes the two talk to
 * each other — which is the only way to prove that a phone and a laptop agree
 * about what an event is.
 *
 * Nothing here touches the filesystem. `store.ts` and `log.ts` are deliberately
 * left out: they need a Capacitor filesystem that does not exist in Node, and
 * what they would add to this test is covered by `fs.test.ts` instead. What is
 * exported is the part where a disagreement would be silent and fatal — ids,
 * signatures and encryption.
 */

export {
  canonicalise,
  causalSort,
  createEvent,
  digestContent,
  findHeads,
  mergeEvents,
  verifyEvent,
  type SignedEvent,
} from "../../../for-desktop-p2p/src/p2p/events";

export {
  createIdentity,
  signDigest,
  userIdFromPublicKey,
  verifyDigest,
  type Identity,
} from "../../../for-desktop-p2p/src/p2p/identity";

export {
  agree,
  deriveKey,
  isSealed,
  open,
  randomKey,
  seal,
} from "../../../for-desktop-p2p/src/p2p/crypto";

export {
  missingFrom,
  nextSeq,
  summarise,
} from "../../../for-desktop-p2p/src/p2p/vector";

// The transport, the store and the log — the parts that were left out while
// `node:net`, `node:events` and a real filesystem were missing. Their presence
// here is the check that matters: if these compile against the shims, the
// phone is running the same networking code as the desktop rather than a
// second implementation that has to be kept in step.
export { CommunityStore } from "../../../for-desktop-p2p/src/p2p/store";
export { Transport } from "../../../for-desktop-p2p/src/p2p/transport";
export { BlobStore, blobId } from "../../../for-desktop-p2p/src/p2p/blobs";
