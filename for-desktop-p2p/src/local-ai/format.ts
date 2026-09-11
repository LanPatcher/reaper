/**
 * The model, the prompt format it was trained on, and how to sample from it.
 *
 * Kept in a module of its own, with no imports, so the test can hold the real
 * thing up against a real chat wrapper. A copy is exactly what would have
 * hidden the bug this file exists to prevent.
 *
 * ## Why the format is stated rather than detected
 *
 * `node-llama-cpp` will work a chat format out from the model file, and the
 * guess is only as good as the metadata: a GGUF whose Jinja template fails to
 * parse, or one converted without a template at all, falls back to a generic
 * "### Human:" layout the model has never seen. A small model given the wrong
 * turn markers does not fail loudly — it drifts. It answers a question nobody
 * asked, narrates itself in the third person, or prints its own instructions
 * back at the user.
 *
 * So the format is written down. Qwen2.5-Instruct uses ChatML — every turn
 * opened with `<|im_start|><role>` and closed with `<|im_end|>` — and saying so
 * means the prompt is right whatever the file happens to carry, and wrong in
 * one obvious, fixable place if the model is ever swapped again. Both markers
 * are real tokens in Qwen's vocabulary, and the wrapper's special-token
 * handling is what makes them tokenise as one token each rather than as a
 * dozen characters — which is also what gives generation something to stop at.
 *
 * ## Why the assistant marker hangs off the end of the user turn
 *
 * It belongs in the template's completion slot, and putting it there does not
 * work. `TemplateChatWrapper` omits the completion prefix entirely when the
 * model's turn is empty — and empty is exactly what it is at the one moment
 * that matters, because `LlamaChat` appends a blank model turn to the history
 * immediately before generating. The prompt then ends on a *closing* marker, so
 * the model is asked to carry on after the end of a turn and answers the only
 * sensible way: by ending another one. Every single reply comes back empty.
 *
 * Hanging the marker off the end of every user turn puts it at the same point
 * in the token stream and never depends on the model's turn being non-empty.
 * The model template drops its own copy to match, so a turn is opened exactly
 * once. `prompt.test.ts` checks the three shapes this has to survive: a fresh
 * chat, a chat with history, and a re-render part way through a reply.
 */
export const CHATML_FORMAT = {
  template:
    "<|im_start|>system\n{{systemPrompt}}<|im_end|>\n{{history}}{{completion}}<|im_end|>\n",
  historyTemplate: {
    system: "<|im_start|>system\n{{message}}<|im_end|>\n",
    user: "<|im_start|>user\n{{message}}<|im_end|>\n<|im_start|>assistant\n",
    model: "{{message}}<|im_end|>\n",
  },
} as const;

/**
 * Anything that means "stop, the turn is over".
 *
 * Belt and braces beside the wrapper's own end-of-turn token. A small model
 * that has lost the thread will happily write the *next* turn as well — the
 * user's line, or a fresh system block — and without this the whole invented
 * exchange streams into the chat as though the character had said it.
 */
export const STOP_MARKERS = ["<|im_start|>", "<|im_end|>"];

/**
 * How to sample from this model.
 *
 * These are the values Qwen ships in its own `generation_config.json`, not
 * guesses. A small model is far more sensitive to them than a large one: left
 * on a bare temperature it wanders off the subject within a paragraph and then
 * starts repeating itself, and pushed too hot it stops producing sentences
 * altogether.
 *
 * `maxTemperature` is a ceiling on the per-character setting rather than a
 * replacement for it. Somebody who wants a wilder character should get one;
 * nobody wants the dial that breaks the model, so the top of the range is the
 * highest value that still writes prose.
 */
export const SAMPLING = {
  topK: 20,
  topP: 0.8,
  /** Off: `topK` and `topP` already cut the tail, and stacking a third filter
   *  on a 1.5B mostly costs it the words that make a sentence interesting. */
  minP: 0,
  repeatPenalty: {
    lastTokens: 64,
    penalty: 1.05,
    frequencyPenalty: 0,
    presencePenalty: 0,
  },
  defaultTemperature: 0.7,
  maxTemperature: 1.2,
} as const;
