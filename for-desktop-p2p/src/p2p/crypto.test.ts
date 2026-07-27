import { createEncryptionKeys, agree, deriveKey, randomKey, seal, open, isSealed } from "./crypto";
let f=0; const ck=(n:string,c:boolean,e="")=>{console.log((c?"PASS":"FAIL")+"  "+n+(e?"  "+e:""));if(!c)f++;};

const alice = createEncryptionKeys();
const bob = createEncryptionKeys();
const eve = createEncryptionKeys();

// --- key agreement ----------------------------------------------------------
const ab = agree(alice.encPrivateKey, bob.encPublicKey);
const ba = agree(bob.encPrivateKey, alice.encPublicKey);
ck("both sides derive the same secret", ab.equals(ba));
ck("secret is 32 bytes", ab.length === 32);

const ae = agree(alice.encPrivateKey, eve.encPublicKey);
ck("a third party derives a different secret", !ab.equals(ae));

// --- context binding --------------------------------------------------------
const k1 = deriveKey(ab, "dm:alice-bob");
const k2 = deriveKey(ab, "dm:alice-bob");
const k3 = deriveKey(ab, "server:general");
ck("same context, same key", k1.equals(k2));
ck("different context, different key", !k1.equals(k3));

// --- seal / open ------------------------------------------------------------
const msg = { channelId: "c1", content: "meet at the usual place", files: [] };
const sealed = seal(msg, k1);
ck("sealed is flagged", isSealed(sealed));
ck("plaintext is not flagged", !isSealed(msg));
ck("ciphertext hides content", !JSON.stringify(sealed).includes("usual place"));

const opened = open(sealed, k1) as any;
ck("round-trips", opened && opened.content === msg.content);
ck("preserves structure", Array.isArray(opened.files) && opened.channelId === "c1");

// --- wrong key --------------------------------------------------------------
ck("wrong key returns undefined", open(sealed, k3) === undefined);
ck("eve cannot read it", open(sealed, deriveKey(ae, "dm:alice-bob")) === undefined);

// --- tampering --------------------------------------------------------------
const tampered = { ...sealed, c: Buffer.from(Buffer.from(sealed.c, "base64").map((b,i)=> i===5?b^0xff:b)).toString("base64") };
ck("tampered ciphertext refused", open(tampered as any, k1) === undefined);
const badTag = { ...sealed, t: Buffer.alloc(16).toString("base64") };
ck("bad auth tag refused", open(badTag as any, k1) === undefined);

// --- nonce uniqueness -------------------------------------------------------
const nonces = new Set<string>();
for (let i=0;i<200;i++) nonces.add(seal({i}, k1).n);
ck("nonces are unique", nonces.size === 200, String(nonces.size));

// --- community keys ---------------------------------------------------------
const ck1 = randomKey();
ck("random key is 32 bytes", Buffer.from(ck1,"base64").length === 32);
ck("random keys differ", ck1 !== randomKey());

const cKey = Buffer.from(ck1, "base64");
const s2 = seal({ secret: true }, cKey);
ck("community key round-trips", (open(s2, cKey) as any).secret === true);
ck("non-member cannot read", open(s2, Buffer.from(randomKey(),"base64")) === undefined);

console.log(f ? "\n"+f+" FAILED" : "\nall passed");
process.exit(f?1:0);
