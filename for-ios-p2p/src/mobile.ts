/**
 * The behaviour half of the phone layout.
 *
 * `mobile.css` moves the panels off-screen; this is what opens them, and what
 * substitutes for the two input gestures a phone does not have — hovering and
 * right-clicking.
 *
 * Everything here is additive. It attaches to the interface from outside rather
 * than modifying it, so the shared page stays exactly as the desktop ships it.
 */

/** Whether the left slide-over is showing. */
function navOpen(): boolean {
  return document.documentElement.classList.contains("nav-open");
}

function setNav(open: boolean): void {
  document.documentElement.classList.toggle("nav-open", open);
}

function setMembers(open: boolean): void {
  document.documentElement.classList.toggle("members-open", open);
}

export function installMobileLayout(): void {
  const root = document.documentElement;
  root.classList.add("mobile");

  addScrim();
  closeOnNavigation();
  closeOnEscape();
  longPressAsContextMenu();
  swipeToOpen();
  keepComposerAboveKeyboard();
}

/**
 * Escape closes the panels.
 *
 * For the hardware keyboard an iPad or a paired phone may have. Costs four
 * lines and removes a dead end.
 */
function closeOnEscape(): void {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!navOpen() && !document.documentElement.classList.contains("members-open")) return;

    setNav(false);
    setMembers(false);
    event.stopPropagation();
  }, true);
}

/**
 * The dimmer behind the slide-over. Tapping it closes.
 *
 * Put inside `#shell`, and that is the whole of why the menu button did not
 * work. `#shell` gets `position: relative; z-index: 1` as soon as a wallpaper
 * is set — that is how the interface lifts itself above the background image —
 * and a `z-index` on a positioned element creates a stacking context. Every
 * z-index inside it is then resolved *against its siblings*, not against the
 * page.
 *
 * So a scrim appended to `document.body` sat at 35 in the root stacking
 * context, while the panels at 40 and the button at 45 were sealed inside a
 * context whose own index was 1. The scrim covered all of them. Tapping the
 * hamburger hit the dimmer instead, which closes the panel — so opening looked
 * fine and the button looked dead, and the two behaviours are indistinguishable
 * from "the button is broken".
 *
 * Inside `#shell` the three are siblings again and the order means what it
 * says, wallpaper or not.
 */
function addScrim(): void {
  const scrim = document.createElement("div");
  scrim.id = "nav-scrim";
  scrim.addEventListener("click", () => {
    setNav(false);
    setMembers(false);
  });

  (document.getElementById("shell") ?? document.body).appendChild(scrim);
}

/*
 * There is no menu button, on purpose.
 *
 * There was one — a hamburger grafted into the top bar — and it is gone at the
 * user's request: the edge swipe is enough, and the button was never really
 * this app's to place. The top bar belongs to the shared interface, which
 * rebuilds it whenever the view changes, so anything inserted there had to be
 * watched and re-inserted, and had to be argued above a dimmer it did not know
 * about. That is a lot of machinery for a control the gesture already covers.
 *
 * What replaces it has to be discoverable, which is why the edge is generous
 * and a flick counts as well as a drag — see `swipeToOpen`.
 */

/**
 * Close the slide-over once something in it has been chosen.
 *
 * Without this, tapping a conversation opens it *behind* a panel that is still
 * covering it, and the app looks like it ignored the tap.
 *
 * Delegated from the panels themselves rather than bound to each row, because
 * the rows are rebuilt constantly — every repaint would otherwise need
 * re-binding, and the ones that were missed would be the ones that felt broken.
 */
function closeOnNavigation(): void {
  for (const id of ["rail", "side"]) {
    const panel = document.getElementById(id);
    if (!panel) continue;

    panel.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      // Only for things that actually navigate. A tap on the panel background,
      // or on a control inside it, should leave it open.
      if (!target.closest(".row, .chan, .srv, .friend")) return;

      // After the interface has handled it, so the panel is not torn away
      // mid-click.
      setTimeout(() => setNav(false), 60);
    });
  }
}

/**
 * Long-press where the desktop uses right-click.
 *
 * The interface listens for `contextmenu`, which iOS Safari fires only
 * sporadically on a long press. Synthesising it means the existing menus work
 * untouched rather than needing a second code path.
 */
function longPressAsContextMenu(): void {
  const HOLD_MS = 500;
  const MOVE_TOLERANCE = 10;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;

    const target = event.target as HTMLElement;

    timer = setTimeout(() => {
      timer = undefined;

      // A short buzz, so it is obvious the press registered rather than the
      // tap having been missed.
      navigator.vibrate?.(10);

      target.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: startX,
        clientY: startY,
      }));
    }, HOLD_MS);
  }, { passive: true });

  // Scrolling is not a long press.
  document.addEventListener("touchmove", (event) => {
    const touch = event.touches[0];
    if (!touch) return;

    if (
      Math.abs(touch.clientX - startX) > MOVE_TOLERANCE ||
      Math.abs(touch.clientY - startY) > MOVE_TOLERANCE
    ) {
      cancel();
    }
  }, { passive: true });

  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
}

/**
 * Swipe from the edge to open, swipe anywhere to close.
 *
 * Deliberately stateless, and that is a correction rather than a preference.
 *
 * The version before this followed the finger: it added a `nav-dragging` class,
 * set a `--nav-drag` custom property every `touchmove`, and cleared both on
 * release. It looks nicer and it has a failure mode that a threshold gesture
 * simply does not have — if the release is ever missed, the panel is left
 * frozen part-way across the screen, half covering the conversation, with no
 * way to put it back. That is not hypothetical; it is what shipped, and the
 * touch sequence gets interrupted more often on this platform than anywhere
 * else: the system's own drag can claim it, a re-render can move the element
 * out from under it, a call or a notification can cancel it outright.
 *
 * Nothing is written down here that has to be cleaned up. The panel is open or
 * it is closed, the CSS transition does the movement, and there is no third
 * state to be stranded in.
 */
function swipeToOpen(): void {
  /** How far in from the left edge a drag may start when closed. */
  const EDGE = 40;

  /** How far the finger has to travel for a swipe to count. */
  const DISTANCE = 45;

  /** Pixels per millisecond that count as a flick regardless of distance. */
  const FLICK = 0.4;

  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let tracking = false;

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) { tracking = false; return; }

    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startAt = event.timeStamp;

    // Opening starts at the edge. Closing starts anywhere, because when the
    // panel is open the whole screen belongs to it.
    tracking = navOpen() || startX <= EDGE;
  }, { passive: true });

  const finish = (event: TouchEvent) => {
    if (!tracking) return;
    tracking = false;

    const touch = event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Horizontal, or it was a scroll that drifted sideways.
    if (Math.abs(dy) > Math.abs(dx)) return;

    const speed = Math.abs(dx) / Math.max(1, event.timeStamp - startAt);
    if (Math.abs(dx) < DISTANCE && speed < FLICK) return;

    if (dx > 0) setNav(true);
    else setNav(false);
  };

  document.addEventListener("touchend", finish, { passive: true });

  // A cancelled touch closes nothing and opens nothing. Saying so explicitly
  // rather than letting `tracking` stay true into the next gesture.
  document.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
}

/**
 * Keep the composer above the keyboard.
 *
 * iOS does not resize the page when the keyboard appears — it scrolls the
 * whole view instead, which on a fixed layout leaves the input underneath it.
 * `visualViewport` reports the space actually visible, so the shell is sized
 * to that.
 */
function keepComposerAboveKeyboard(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const apply = () => {
    // The gap between the layout viewport and what can be seen is the
    // keyboard, near enough.
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty("--keyboard", `${covered}px`);

    const shell = document.getElementById("shell");
    if (shell) shell.style.height = `${viewport.height}px`;

    // Follow the conversation down as it shrinks, so the message being replied
    // to does not scroll out from under the keyboard.
    const messages = document.getElementById("messages");
    if (messages && covered > 0) {
      messages.scrollTop = messages.scrollHeight;
    }
  };

  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}
