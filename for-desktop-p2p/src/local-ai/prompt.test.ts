import { LlamaText, TemplateChatWrapper } from "node-llama-cpp";

import { CHATML_FORMAT, SAMPLING, STOP_MARKERS } from "./format";

/**
 * The prompt the model is actually handed.
 *
 * Every reply came back empty once, and nothing in the app said why: the model
 * loaded, generation ran, and what came back was nothing at all. The cause was
 * one missing marker at the end of the prompt — `TemplateChatWrapper` drops the
 * completion prefix when the model's turn is empty, which is precisely its
 * state at the moment before generating. The model was asked to continue after
 * the end of a turn, and did the obvious thing.
 *
 * That is invisible from anywhere else in the codebase, so it is checked here,
 * against a real wrapper built from the format the app ships. Reimplementing
 * the layout in the test would only prove the test agrees with itself.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const wrapper = new TemplateChatWrapper(
  CHATML_FORMAT as unknown as ConstructorParameters<typeof TemplateChatWrapper>[0],
);

/** The prompt as one string, with the special markers left in place. */
function render(history: unknown[]): string {
  const { contextText } = wrapper.generateContextState({
    chatHistory: history as never,
  });

  // `toJSON` is an array of parts, or a bare string when there is nothing
  // special in the text — which is not the case here, but assuming otherwise is
  // how a test starts throwing instead of failing.
  const json = contextText.toJSON();
  const parts = Array.isArray(json) ? json : [json];

  return parts
    .map((part) =>
      typeof part === "string" ? part : (part as { value: string }).value,
    )
    .join("");
}

const system = { type: "system", text: LlamaText("SHEET").toJSON() };

// What `LlamaChat` builds immediately before generating: a blank model turn on
// the end of the history. This is the shape that used to lose the marker.
const fresh = render([system, { type: "user", text: "hello?" }, { type: "model", response: [] }]);

const ongoing = render([
  system,
  { type: "user", text: "hi" },
  { type: "model", response: ["Hello there."] },
  { type: "user", text: "and now?" },
  { type: "model", response: [] },
]);

// Part way through a reply, which is what a context shift re-renders.
const midReply = render([
  system,
  { type: "user", text: "hi" },
  { type: "model", response: ["Hello th"] },
]);

// ---- byte-for-byte against the format Qwen documents ----------------------
//
// Spelled out in full rather than assembled from the same constants the code
// uses. A test that builds its expectation the way the subject does can only
// ever agree with it.
ck("a fresh chat is exactly Qwen's ChatML layout",
   fresh === "<|im_start|>system\nSHEET<|im_end|>\n" +
             "<|im_start|>user\nhello?<|im_end|>\n" +
             "<|im_start|>assistant\n",
   JSON.stringify(fresh));

ck("and so is one with history",
   ongoing === "<|im_start|>system\nSHEET<|im_end|>\n" +
               "<|im_start|>user\nhi<|im_end|>\n" +
               "<|im_start|>assistant\nHello there.<|im_end|>\n" +
               "<|im_start|>user\nand now?<|im_end|>\n" +
               "<|im_start|>assistant\n",
   JSON.stringify(ongoing));

// ---- the thing that broke -------------------------------------------------
ck("the prompt hands the model an open assistant turn",
   fresh.endsWith("<|im_start|>assistant\n") &&
   ongoing.endsWith("<|im_start|>assistant\n"));

ck("it never ends on a closing marker",
   !fresh.endsWith("<|im_end|>\n") && !ongoing.endsWith("<|im_end|>\n"));

ck("a turn is opened exactly once per reply",
   (ongoing.match(/<\|im_start\|>assistant/g) ?? []).length === 2,
   String((ongoing.match(/<\|im_start\|>assistant/g) ?? []).length));

ck("a half-written reply is continued rather than restarted",
   midReply.endsWith("<|im_start|>assistant\nHello th"), JSON.stringify(midReply.slice(-32)));

// ---- what stops generation ------------------------------------------------
ck("both turn markers are stop triggers",
   STOP_MARKERS.includes("<|im_start|>") && STOP_MARKERS.includes("<|im_end|>"),
   STOP_MARKERS.join(" "));

const { stopGenerationTriggers } = wrapper.generateContextState({
  chatHistory: [system, { type: "user", text: "hi" }, { type: "model", response: [] }] as never,
});
ck("and the end-of-turn token is one as well",
   JSON.stringify(stopGenerationTriggers.map((s) => s.toJSON())).includes('"EOS"'));

// ---- sampling stays in a range the model can write in ---------------------
ck("the temperature ceiling still produces prose",
   SAMPLING.maxTemperature > SAMPLING.defaultTemperature && SAMPLING.maxTemperature <= 1.5,
   String(SAMPLING.maxTemperature));

ck("the tail is cut", SAMPLING.topK > 0 && SAMPLING.topP > 0 && SAMPLING.topP < 1);

ck("repetition is penalised, but not so hard it forbids ordinary words",
   SAMPLING.repeatPenalty.penalty > 1 && SAMPLING.repeatPenalty.penalty <= 1.2,
   String(SAMPLING.repeatPenalty.penalty));

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
