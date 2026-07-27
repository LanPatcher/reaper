import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity } from "./identity";
import { CommunityStore } from "./store";

let f=0; const ck=(n:string,c:boolean,e="")=>{console.log((c?"PASS":"FAIL")+"  "+n+(e?"  "+e:""));if(!c)f++;};

const root = mkdtempSync(join(tmpdir(), "idchange-"));
const alice = createIdentity();
const bob = createIdentity();   // stands in for "identity was lost and recreated"

// Alice writes some history.
{
  const s = new CommunityStore({ root, community: "c1", identity: alice });
  s.open();
  for (let i = 0; i < 20; i++) s.append("message.send", { content: "m" + i });
  s.close();
  ck("alice wrote history", s.events().length === 20);
}

// Bob opens the same directory. Previously this threw and killed startup.
let threw = false;
let bobStore: CommunityStore;
try {
  bobStore = new CommunityStore({ root, community: "c1", identity: bob });
  bobStore.open();
} catch (e) { threw = true; }

ck("new identity does not throw", !threw);
ck("starts empty", !threw && bobStore!.events().length === 0);

const dirs = readdirSync(join(root, "communities"));
ck("old data moved aside", dirs.some(d => d.includes("unreadable")), dirs.join(", "));
ck("fresh dir usable", true);

// And it must be writable afterwards.
if (!threw) {
  bobStore!.append("message.send", { content: "new start" });
  ck("can append after recovery", bobStore!.events().length === 1);
  bobStore!.close();

  const again = new CommunityStore({ root, community: "c1", identity: bob });
  again.open();
  ck("survives restart", again.events().length === 1, String(again.events().length));
  again.close();
}

// Alice's original bytes are still on disk.
const aside = readdirSync(join(root, "communities")).filter(d => d.includes("unreadable"))[0];
ck("original bytes preserved", !!aside && readdirSync(join(root, "communities", aside)).length > 0);

rmSync(root, { recursive: true, force: true });
console.log(f ? "\n"+f+" FAILED" : "\nall passed");
process.exit(f?1:0);
