import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a message body draws, and who can be mentioned.
 *
 * ## Why this is tested rather than eyeballed
 *
 * Both of these are decisions made per token in a loop over somebody's text,
 * and both fail quietly. A mention that is not recognised renders as ordinary
 * words, which looks like nothing happening; a suggestion list drawn from the
 * wrong set offers a name that cannot actually be mentioned here, so the
 * message goes out addressed to nobody and looks like the network losing it.
 *
 * Neither shows up as an error, so both are asserted.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

function region(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to);
  if (a < 0 || b < 0) {
    console.log(`FAIL  could not find ${from} in index.html`);
    process.exit(1);
  }
  return html.slice(a, b);
}

// ---- a document, in as much detail as a message body needs -----------------
interface Node {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  href?: string;
  children: Node[];
  style: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
  appendChild: (n: Node) => Node;
  querySelector: () => null;
}

function el(tag: string): Node {
  const n: Node = {
    tag,
    className: "",
    textContent: "",
    title: "",
    children: [],
    style: {},
    setAttribute: () => undefined,
    appendChild(c: Node) { n.children.push(c); return c; },
    querySelector: () => null,
  };
  return n;
}

const documentStub = {
  createElement: (tag: string) => el(tag),
  createTextNode: (text: string) => {
    const n = el("#text");
    n.textContent = text;
    return n;
  },
};

/** Every node in the tree, flattened, so a body can be searched. */
function flatten(node: Node): Node[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** What the reader ends up looking at. */
function textOf(node: Node): string {
  if (node.tag === "#text") return node.textContent;
  if (!node.children.length) return node.textContent;
  return node.children.map(textOf).join("");
}

// ---- the code under test ---------------------------------------------------
const links = region("      // ---- links", "      // ---- end links");
const content = region("      // ---- message content", "      // ---- end message content");
const mentions = region("      // ---- mention candidates", "      // ---- end mention candidates");

type World = {
  current: string;
  username: string;
  profiles: Record<string, { username: string }>;
  friends: { userId: string; username: string }[];
  me: { userId: string };
  members: string[];
};

function build(world: World) {
  const t = (s: string) => s;
  const nameOf = (uid: string) =>
    uid === world.me.userId ? world.username : world.profiles[uid]?.username || uid.slice(0, 8);

  return new Function(
    "document", "URL", "URLSearchParams", "window",
    "t", "current", "username", "profiles", "friends", "me",
    "membersOf", "nameOf",
    links + "\n" + content + "\n" + mentions +
      "\nreturn { renderContent: renderContent, candidates: candidates };",
  )(
    documentStub, URL, URLSearchParams, { links: {} },
    t, world.current, world.username, world.profiles, world.friends, world.me,
    () => world.members, nameOf,
  ) as {
    renderContent: (el: Node, text: string) => void;
    candidates: (prefix: string) => { id: string; name: string }[];
  };
}

const WORLD: World = {
  current: "s-server-1",
  username: "ray",
  profiles: { u_bob: { username: "bob" }, u_zoe: { username: "zoe" } },
  friends: [{ userId: "u_bob", username: "bob" }],
  me: { userId: "u_me" },
  members: ["u_me", "u_bob"],
};

/** Whether any element in a render carries a given class. */
function has(classes: string[], want: string): boolean {
  return classes.some((c) => c.split(" ").includes(want));
}

/** The classes a rendered body assigns, in order. */
function render(text: string, world: World = WORLD) {
  const body = el("div");
  build(world).renderContent(body, text);
  return {
    body,
    classes: flatten(body).map((n) => n.className).filter(Boolean),
    text: textOf(body),
  };
}

// ---- the thing that was reported -------------------------------------------
{
  const r = render("hey @everyone look at this");
  ck("@everyone is highlighted in a server",
     has(r.classes, "mention"), JSON.stringify(r.classes));
  ck("and the text still reads as written",
     r.text === "hey @everyone look at this", JSON.stringify(r.text));
}

{
  const r = render("@everyone", { ...WORLD, current: "g-group-1" });
  ck("@everyone is highlighted in a group chat too",
     has(r.classes, "mention"), JSON.stringify(r.classes));
}

{
  const r = render("@everyone on its own at the start of a line");
  ck("even at the very start of a message",
     has(r.classes, "mention"), JSON.stringify(r.classes));
}

{
  const r = render("@Everyone", WORLD);
  ck("and however it is capitalised", has(r.classes, "mention"));
}

{
  // Addressing the room is a different act from naming one person, so it is
  // drawn differently. Looking the same is what made it read as unrecognised.
  const room = render("@everyone").classes.join("|");
  const one = render("hi @bob").classes.join("|");
  ck("@everyone is marked out from an ordinary mention",
     room.includes("everyone") && !one.includes("everyone"),
     room + "   vs   " + one);
}

{
  const r = render("@everyone", { ...WORLD, current: "dm-abc" });
  ck("but not in a direct conversation, where there is no channel to notify",
     !has(r.classes, "mention"), JSON.stringify(r.classes));
}

// ---- ordinary mentions -----------------------------------------------------
ck("somebody in the conversation is highlighted",
   has(render("hi @bob").classes, "mention"));
ck("a name nobody here has is left as text",
   !has(render("hi @nobodyatall").classes, "mention"));

// ---- links still work alongside them ---------------------------------------
{
  const r = render("see https://youtu.be/dQw4w9WgXcQ and tell @bob");
  ck("a link and a mention in one message both render",
     has(r.classes, "msglink") && has(r.classes, "mention"),
     JSON.stringify(r.classes));
}

// ---- who can be mentioned --------------------------------------------------
{
  const world: World = {
    ...WORLD,
    // Friends and profiles the app knows about, but who are not in this
    // conversation. These used to be offered, which is the bug.
    friends: [
      { userId: "u_bob", username: "bob" },
      { userId: "u_far", username: "faraway" },
    ],
    profiles: {
      u_bob: { username: "bob" },
      u_far: { username: "faraway" },
      u_zoe: { username: "zoe" },
    },
    members: ["u_me", "u_bob"],
  };

  const names = build(world).candidates("").map((c) => c.name);

  ck("somebody in the conversation is offered", names.includes("bob"), names.join(", "));
  ck("a friend who is not in it is not", !names.includes("faraway"), names.join(", "));
  ck("nor is a profile seen somewhere else", !names.includes("zoe"), names.join(", "));
  ck("you are not offered yourself", !names.includes("ray"), names.join(", "));
  ck("@everyone is offered in a server", names.includes("everyone"), names.join(", "));

  const inDm = build({ ...world, current: "dm-abc", members: ["u_me", "u_bob"] })
    .candidates("").map((c) => c.name);
  ck("but not in a direct conversation", !inDm.includes("everyone"), inDm.join(", "));

  ck("typing narrows the list",
     build(world).candidates("bo").map((c) => c.name).join(",") === "bob",
     build(world).candidates("bo").map((c) => c.name).join(","));
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
