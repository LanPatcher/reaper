import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createIdentity } from "./identity";

/**
 * Exporting an identity, and the boundary that broke it.
 *
 * An identity export is the only way an account can survive a lost machine.
 * There is no server to reset against and no recovery flow — the private key is
 * the account — so this failing is not an inconvenience, it is the difference
 * between having a backup and believing you have one.
 *
 * It was failing. Every export threw:
 *
 *     error:030000AC:digital envelope routines::memory limit exceeded
 *
 * Scrypt needs `128 * N * r` bytes. At N = 32768 and r = 8 that is exactly
 * 33,554,432 — which is exactly Node's default `maxmem`, and Node requires the
 * requirement to be *below* the ceiling rather than at it. So parameters chosen
 * to be deliberately expensive landed precisely one byte the wrong side of a
 * default nobody had written down.
 *
 * These tests pin both halves: that the parameters the app ships actually run,
 * and that the boundary is understood rather than avoided by luck.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// ---- the parameters the app actually uses ----------------------------------
//
// Read out of the source rather than duplicated here. A copy would keep
// passing while the app kept failing, which is the specific way this bug hid.
{
  // Read from where the parameters live, which is no longer `bridge.ts`.
  //
  // They moved to `backup-bundle.ts` when packing and unpacking a backup were
  // pulled out of the IPC handlers so they could be run by a test. This
  // assertion following them there is the point of reading the source rather
  // than copying the numbers: a copy would have gone on passing.
  const source = readFileSync(
    join(process.cwd(), "src/p2p/backup-bundle.ts"), "utf8",
  );
  const block = source.slice(source.indexOf("const IDENTITY_KDF"));
  const declaration = block.slice(0, block.indexOf("}"));

  // A small arithmetic reader rather than `eval`. The declaration is written
  // the way a person would write it — `2 ** 15`, `96 * 1024 * 1024` — so the
  // number has to be worked out rather than parsed, and running the source as
  // code to find out is not a habit worth having in a test suite.
  const read = (name: string) => {
    const match = declaration.match(new RegExp(`${name}:\\s*([^,\\n]+)`));
    if (!match) return NaN;

    return match[1]
      .split("*")
      .reduce<{ value: number; power: boolean }>(
        (state, part) => {
          // An empty part is the second half of a `**`, which means the next
          // number is an exponent rather than another factor.
          if (part.trim() === "") return { ...state, power: true };

          const n = Number(part.trim());
          if (!Number.isFinite(n)) return { value: NaN, power: false };

          return {
            value: Number.isNaN(state.value)
              ? n
              : state.power
                ? state.value ** n
                : state.value * n,
            power: false,
          };
        },
        { value: NaN, power: false },
      ).value;
  };

  const N = read("N");
  const r = read("r");
  const p = read("p");
  const maxmem = read("maxmem");

  ck("the app declares scrypt parameters", Number.isFinite(N) && Number.isFinite(r),
     `N=${N} r=${r} p=${p} maxmem=${maxmem}`);

  // The arithmetic, stated so the next person changing N does not have to
  // rediscover it from an OpenSSL error message.
  const needed = 128 * N * r;

  ck("memory is budgeted for, not left to a default",
     Number.isFinite(maxmem), String(maxmem));
  ck("and the budget is above what the parameters need",
     maxmem > needed, `${maxmem} available, ${needed} needed`);

  // The parameters still have to be worth having. Dropping N to fit under a
  // default would "fix" this and quietly weaken every backup.
  ck("the parameters are still expensive enough",
     N >= 2 ** 15 && r >= 8, `N=${N} r=${r}`);

  // And the thing that was actually broken: they run.
  let derived: Buffer | undefined;
  let threw = "";
  try {
    derived = scryptSync("a real passphrase", randomBytes(16), 32, { N, r, p, maxmem });
  } catch (error) {
    threw = (error as Error).message;
  }

  ck("deriving a key with them works", !!derived && derived.length === 32, threw);

  // The boundary itself, to show it is understood. Node's default ceiling is
  // 32 MiB and these parameters need exactly that, so without an explicit
  // budget they fail — which is the bug, reproduced.
  let atTheLimit = "";
  try {
    scryptSync("a real passphrase", randomBytes(16), 32, { N, r, p });
  } catch (error) {
    atTheLimit = (error as Error).message;
  }

  ck("and without a budget they would still fail",
     atTheLimit.includes("memory limit exceeded"),
     atTheLimit || "no error — the default ceiling has moved");
}

// ---- a real round trip ------------------------------------------------------
//
// Mirrors what the bridge does, because the parts that matter are shared
// between export and import and a difference between them produces a file that
// can be written and never opened.
{
  const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

  function exportIdentity(identity: unknown, passphrase: string): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, identity, index: [], at: Date.now() }),
      "utf8",
    );

    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32, KDF);
    const nonce = randomBytes(12);

    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(payload), cipher.final()]);

    return JSON.stringify({
      reaper: "identity",
      v: 1,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: body.toString("base64"),
    });
  }

  function importIdentity(bundle: string, passphrase: string): unknown {
    const outer = JSON.parse(bundle) as Record<string, string>;
    const salt = Buffer.from(outer.salt, "base64");
    const key = scryptSync(passphrase, salt, 32, KDF);

    const decipher = createDecipheriv(
      "aes-256-gcm", key, Buffer.from(outer.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(outer.tag, "base64"));

    const plain = Buffer.concat([
      decipher.update(Buffer.from(outer.data, "base64")),
      decipher.final(),
    ]);

    return (JSON.parse(plain.toString("utf8")) as { identity: unknown }).identity;
  }

  const mine = createIdentity();
  const passphrase = "correct horse battery staple";

  let bundle = "";
  let threw = "";
  try {
    bundle = exportIdentity(mine, passphrase);
  } catch (error) {
    threw = (error as Error).message;
  }

  ck("an identity exports", !!bundle, threw);

  const back = importIdentity(bundle, passphrase) as typeof mine;

  ck("and comes back as the same account", back.userId === mine.userId,
     `${back.userId} vs ${mine.userId}`);
  ck("with the private key intact", back.privateKey === mine.privateKey);
  ck("and the encryption keys too", back.encPrivateKey === mine.encPrivateKey);

  // The wrong passphrase must fail as authentication rather than yielding
  // something that happens to parse.
  let refused = false;
  try {
    importIdentity(bundle, "not the passphrase");
  } catch {
    refused = true;
  }
  ck("the wrong passphrase is refused", refused);

  // As must a file somebody has edited.
  const bent = JSON.parse(bundle) as Record<string, string>;
  bent.data = Buffer.from("something else entirely").toString("base64");

  let rejected = false;
  try {
    importIdentity(JSON.stringify(bent), passphrase);
  } catch {
    rejected = true;
  }
  ck("a damaged file is refused", rejected);

  // Every field the reader needs has to be present, or the failure lands as an
  // unhelpful exception several layers in.
  const outer = JSON.parse(bundle) as Record<string, string>;
  ck("the file carries salt, nonce and tag",
     !!outer.salt && !!outer.nonce && !!outer.tag && !!outer.data);
  ck("and says what it is", outer.reaper === "identity", outer.reaper);
}

// ---- cost -------------------------------------------------------------------
//
// Expensive is the point; unusable is not. If this ever creeps past a second or
// two, exporting starts to feel broken and people stop making backups.
{
  const started = Date.now();
  scryptSync("a passphrase", randomBytes(16), 32, {
    N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024,
  });
  const took = Date.now() - started;

  ck("deriving a key is quick enough to feel instant", took < 2000, `${took} ms`);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
