import { randomBytes } from "node:crypto";
import { rmSync, mkdtempSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, logExists, touchLog } from "./log";
import { encodeFrame, decodeFrame } from "./frames";

const key = randomBytes(32);
let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
}

// --- frame round-trip -------------------------------------------------------
{
  const payload = Buffer.from("hello ".repeat(1000));
  const frame = encodeFrame(payload, key);
  const out = decodeFrame(frame, 0, key)!;
  check("frame round-trips", out.payload.equals(payload));
  check("frame consumes whole buffer", out.size === frame.length);
  check("frame compresses", frame.length < payload.length / 5, `${payload.length} -> ${frame.length}`);
}

// --- wrong key throws -------------------------------------------------------
{
  const frame = encodeFrame(Buffer.from("secret"), key);
  let threw = false;
  try { decodeFrame(frame, 0, randomBytes(32)); } catch { threw = true; }
  check("wrong key is rejected", threw);
}

// --- truncated frame returns undefined -------------------------------------
{
  const frame = encodeFrame(Buffer.from("x".repeat(500)), key);
  check("truncated frame -> undefined", decodeFrame(frame.subarray(0, frame.length - 10), 0, key) === undefined);
  check("empty buffer -> undefined", decodeFrame(Buffer.alloc(0), 0, key) === undefined);
}

// --- log round-trip ---------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "log-"));
{
  const log = new EventLog(dir, key, { batchSize: 100 });
  for (let i = 0; i < 1000; i++) {
    log.append({ id: `msg-${i}`, channel: "general", author: "ray", content: `message number ${i}` });
  }
  log.close();

  const back = [...log2(dir, key)];
  check("all events read back", back.length === 1000, `got ${back.length}`);
  check("order preserved", (back[0] as any).id === "msg-0" && (back[999] as any).id === "msg-999");
}
function log2(d: string, k: Buffer) { return new EventLog(d, k).read(); }

// --- compression ratio ------------------------------------------------------
{
  const raw = 1000 * JSON.stringify({ id: "msg-500", channel: "general", author: "ray", content: "message number 500" }).length;
  const onDisk = new EventLog(dir, key).size();
  check("compresses well", onDisk < raw / 5, `${raw}B raw -> ${onDisk}B on disk (${(raw/onDisk).toFixed(1)}x)`);
}

// --- torn write recovery ----------------------------------------------------
{
  const d2 = mkdtempSync(join(tmpdir(), "torn-"));
  const log = new EventLog(d2, key, { batchSize: 10 });
  for (let i = 0; i < 30; i++) log.append({ i });
  log.close();

  // simulate a crash mid-append: partial frame glued onto the end
  const seg = join(d2, readdirSync(d2).sort().pop()!);
  appendFileSync(seg, encodeFrame(Buffer.from('{"i":999}\n'), key).subarray(0, 20));

  const recovered = [...new EventLog(d2, key).read()];
  check("torn tail recovered", recovered.length === 30, `got ${recovered.length}`);

  const again = [...new EventLog(d2, key).read()];
  check("partial frame truncated on disk", again.length === 30, `got ${again.length}`);
  rmSync(d2, { recursive: true, force: true });
}

// --- segment rolling --------------------------------------------------------
{
  const d3 = mkdtempSync(join(tmpdir(), "roll-"));
  const log = new EventLog(d3, key, { batchSize: 500 });
  // Random text so compression can't hide the volume and rolling is exercised.
  for (let i = 0; i < 40_000; i++) log.append({ i, text: randomBytes(24).toString("hex") });
  log.close();
  const segs = readdirSync(d3).filter((f) => f.endsWith(".seg"));
  check("rolled to multiple segments", segs.length > 1, `${segs.length} segments`);
  const all = [...new EventLog(d3, key).read()] as any[];
  check("reads across segments", all.length === 40_000, `got ${all.length}`);
  check("order preserved across segments", all[0].i === 0 && all[39_999].i === 39_999);
  rmSync(d3, { recursive: true, force: true });
}

// --- logExists --------------------------------------------------------------
{
  const d4 = mkdtempSync(join(tmpdir(), "exists-"));
  check("empty dir has no log", !logExists(d4));
  touchLog(d4);
  check("touched dir still has no events", !logExists(d4));
  const log = new EventLog(d4, key, { batchSize: 1 });
  log.append({ hello: true });
  log.close();
  check("written dir has a log", logExists(d4));
  rmSync(d4, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
