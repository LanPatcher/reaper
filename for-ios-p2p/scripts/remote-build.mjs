import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Build the IPA on somebody else's Mac and download it here.
 *
 *   npm run ios:build      start a build, wait for it, fetch the IPA
 *   npm run ios:status     what the last few builds did
 *
 * ## Why this exists
 *
 * Xcode is macOS-only. There is no cross-compiler, no Wine path, and no
 * supported way to produce an IPA on Windows — so the compile happens on a
 * hosted Mac and this script is the part that makes that invisible: it starts
 * the build, follows it, and puts `Reaper-unsigned.ipa` in `build/`.
 *
 * ## What it needs
 *
 *   CM_API_TOKEN   Codemagic → Teams → Personal Account → Integrations
 *   CM_APP_ID      in the URL of the app's page in Codemagic
 *
 * Set them once with `setx` and reopen the terminal.
 *
 * ## What to do with the file
 *
 * The IPA is unsigned, deliberately — signing on a build service means giving
 * it an Apple ID. Install it with Sideloadly or AltStore, which re-sign on
 * this machine with your own free Apple ID. That signature lasts seven days;
 * AltStore can refresh it over Wi-Fi before it expires.
 */

const API = "https://api.codemagic.io";
const WORKFLOW = "ios-sideload";

const token = process.env.CM_API_TOKEN;
const appId = process.env.CM_APP_ID;

/** How long to keep following a build before giving up. */
const PATIENCE_MS = 45 * 60 * 1000;

/** How often to ask. Codemagic rate-limits, and a build takes minutes. */
const POLL_MS = 20 * 1000;

function fail(message) {
  console.error(`\n  [X] ${message}\n`);
  process.exit(1);
}

if (!token || !appId) {
  fail(
    "CM_API_TOKEN and CM_APP_ID are not set.\n\n" +
      "      CM_API_TOKEN — Codemagic, Teams, Personal Account, Integrations,\n" +
      "                     Codemagic API. Generate a token.\n" +
      "      CM_APP_ID    — the id in the URL of the app's page.\n\n" +
      "      Then, in a terminal:\n" +
      "        setx CM_API_TOKEN \"...\"\n" +
      "        setx CM_APP_ID \"...\"\n\n" +
      "      and open a new terminal, since setx only affects new ones.",
  );
}

async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "x-auth-token": token,
      "content-type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
  }

  return response.json();
}

// ---- status -----------------------------------------------------------------

if (process.argv.includes("--status")) {
  const { builds } = await call(`/builds?appId=${appId}&limit=8`);

  if (!builds?.length) {
    console.log("\n  No builds yet.\n");
    process.exit(0);
  }

  console.log("");
  for (const build of builds) {
    const when = new Date(build.startedAt ?? build.createdAt).toLocaleString();
    console.log(
      `  ${String(build.status).padEnd(10)} ${when}  ${build.branch ?? ""} ${build._id}`,
    );
  }
  console.log("");
  process.exit(0);
}

// ---- start ------------------------------------------------------------------

const branch = process.argv.find((arg) => arg.startsWith("--branch="))
  ?.slice("--branch=".length) ?? "main";

console.log(`\n  Reaper iOS — building on a hosted Mac\n`);
console.log(`  workflow  ${WORKFLOW}`);
console.log(`  branch    ${branch}\n`);

let buildId;

try {
  const started = await call("/builds", {
    method: "POST",
    body: JSON.stringify({
      appId,
      workflowId: WORKFLOW,
      branch,
    }),
  });

  buildId = started.buildId;
} catch (error) {
  fail(
    `Could not start the build.\n      ${error.message}\n\n` +
      "      If this is a 401, the token is wrong. If it is a 404, check\n" +
      "      CM_APP_ID, or that the workflow id in codemagic.yaml is still\n" +
      `      "${WORKFLOW}".`,
  );
}

console.log(`  started   ${buildId}`);
console.log(`  watching  https://codemagic.io/app/${appId}/build/${buildId}\n`);

// ---- follow -----------------------------------------------------------------

const until = Date.now() + PATIENCE_MS;
let last = "";
let build;

while (Date.now() < until) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));

  try {
    ({ build } = await call(`/builds/${buildId}`));
  } catch (error) {
    // A blip in the middle of a twenty-minute build is not a reason to stop
    // watching it.
    console.log(`  ... could not check just now (${error.message.slice(0, 60)})`);
    continue;
  }

  // The step it is on, which is more useful than "building" for twenty
  // minutes with nothing else said.
  const step = build.buildActions?.findLast((action) => action.status === "building")?.name;
  const line = `${build.status}${step ? ` — ${step}` : ""}`;

  if (line !== last) {
    console.log(`  ${new Date().toLocaleTimeString()}  ${line}`);
    last = line;
  }

  if (["finished", "failed", "canceled", "timeout", "skipped"].includes(build.status)) {
    break;
  }
}

if (!build || !["finished"].includes(build.status)) {
  fail(
    `The build ${build?.status ?? "did not finish in time"}.\n` +
      `      Logs: https://codemagic.io/app/${appId}/build/${buildId}`,
  );
}

// ---- download ---------------------------------------------------------------

const ipa = build.artefacts?.find((artefact) => artefact.name?.endsWith(".ipa"));

if (!ipa) {
  fail(
    "The build finished but produced no IPA.\n" +
      `      Logs: https://codemagic.io/app/${appId}/build/${buildId}`,
  );
}

await mkdir("build", { recursive: true });
const target = `build/${ipa.name}`;

console.log(`\n  downloading  ${ipa.name} (${(ipa.size / 1e6).toFixed(1)} MB)`);

const response = await fetch(ipa.url, { headers: { "x-auth-token": token } });
if (!response.ok) fail(`Could not download the IPA: ${response.status}`);

await pipeline(Readable.fromWeb(response.body), createWriteStream(target));

console.log(`
  Done — ${target}

  To put it on the phone:

    1. Install Sideloadly (sideloadly.io) or AltStore (altstore.io).
    2. Plug the phone in, drag the IPA in, sign in with your Apple ID.
    3. On the phone: Settings, General, VPN & Device Management, and trust
       the developer profile.

  With a free Apple ID the signature lasts seven days and the app stops
  opening after that until it is installed again. AltStore can refresh it
  over Wi-Fi on its own if both devices are on the same network.
`);
