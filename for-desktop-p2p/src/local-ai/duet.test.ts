import {
  clampExchanges,
  perspective,
  runDuet,
  speakerAt,
  type DuetDeps,
  type DuetMessage,
} from "./duet";

/**
 * The turn-taking, checked without the model.
 *
 * The one thing worth testing here is the choreography: that the speakers
 * alternate, that each is primed with exactly what it should have heard so far
 * (its own lines as the assistant, the other's as the user, and NOT the line it
 * is about to answer), and that a stop takes effect. The model is faked with a
 * `reply` that echoes a numbered line, so the transcript is fully predictable.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const A = { id: "a", name: "Ada" };
const B = { id: "b", name: "Boris" };

// ---- pure helpers ----------------------------------------------------------

ck("A opens, then they alternate",
   speakerAt(0, A, B).id === "a" &&
   speakerAt(1, A, B).id === "b" &&
   speakerAt(2, A, B).id === "a");

ck("exchanges are clamped to a sane range",
   clampExchanges(0) === 1 &&
   clampExchanges(5) === 5 &&
   clampExchanges(1000) === 60 &&
   clampExchanges(NaN) === 1 &&
   clampExchanges(3.9) === 3);

const sample: DuetMessage[] = [
  { turn: 0, speakerId: "a", content: "one" },
  { turn: 1, speakerId: "b", content: "two" },
  { turn: 2, speakerId: "a", content: "" }, // a blank turn
];

const pa = perspective("a", sample);
ck("a speaker sees its own lines as the assistant's",
   pa[0].role === "assistant" && pa[0].content === "one");
ck("and the other's lines as the user's",
   pa[1].role === "user" && pa[1].content === "two");
ck("blank turns are dropped from the history", pa.length === 2);

const pb = perspective("b", sample);
ck("the mapping flips for the other speaker",
   pb[0].role === "user" && pb[1].role === "assistant");

// ---- the loop --------------------------------------------------------------
//
// A recording fake: every reply is just "reply-<turn>", and every prime is
// logged with the history it was handed, so the choreography can be asserted.

async function record(exchanges: number, stopAfter = Infinity) {
  const primes: { speakerId: string; history: { role: string; content: string }[] }[] = [];
  const incomings: { speakerId: string; incoming: string }[] = [];
  const messages: DuetMessage[] = [];
  const streamed: string[] = [];
  let produced = 0;

  const deps: DuetDeps = {
    async prime(speakerId, history) {
      primes.push({ speakerId, history });
    },
    async reply(speakerId, incoming, onChunk) {
      incomings.push({ speakerId, incoming });
      const text = `reply-${produced++}`;
      onChunk(text); // one chunk, to prove streaming is wired
      return text;
    },
    cancelled() {
      return messages.length >= stopAfter;
    },
    onMessage(m) {
      messages.push(m);
    },
    onChunk(_s, _t, chunk) {
      streamed.push(chunk);
    },
  };

  const transcript = await runDuet(
    { a: A, b: B, opener: "OPENER", exchanges },
    deps,
  );
  return { primes, incomings, messages, streamed, transcript };
}

async function main() {
const r = await record(4);

ck("it produces exactly the requested number of messages", r.messages.length === 4);
ck("speakers alternate A, B, A, B",
   r.messages.map((m) => m.speakerId).join(",") === "a,b,a,b");
ck("the first speaker answers the opener", r.incomings[0].incoming === "OPENER");
ck("each later speaker answers the previous line",
   r.incomings[1].incoming === "reply-0" &&
   r.incomings[2].incoming === "reply-1" &&
   r.incomings[3].incoming === "reply-2");

// The load-bearing bit: the line a speaker is about to answer must NOT already
// be in its primed history — it arrives as `incoming`. So B's first prime is
// empty (it is answering A's first line, which it has not "heard" as history),
// and A's second prime holds only A's own first line.
ck("the first speaker is primed with nothing", r.primes[0].history.length === 0);
ck("the second speaker is primed with nothing yet", r.primes[1].history.length === 0);
ck("A's second turn is primed with only its own first line",
   r.primes[2].history.length === 1 &&
   r.primes[2].history[0].role === "assistant" &&
   r.primes[2].history[0].content === "reply-0");
ck("B's second turn sees A's two lines as user, its own as assistant",
   r.primes[3].history.length === 2 &&
   r.primes[3].history[0].role === "user" &&
   r.primes[3].history[1].role === "assistant");

ck("chunks stream for every turn", r.streamed.length === 4);

// ---- stopping --------------------------------------------------------------

const s = await record(10, 2);
ck("a stop ends the run early", s.messages.length === 2);
}

main().then(() => {
  console.log(f ? "\n" + f + " FAILED" : "\nall passed");
  process.exit(f ? 1 : 0);
});
