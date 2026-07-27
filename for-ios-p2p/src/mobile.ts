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
  addMenuButton();
  closeOnNavigation();
  longPressAsContextMenu();
  swipeToOpen();
  keepComposerAboveKeyboard();
}

/** The dimmer behind the slide-over. Tapping it closes. */
function addScrim(): void {
  const scrim = document.createElement("div");
  scrim.id = "nav-scrim";
  scrim.addEventListener("click", () => {
    setNav(false);
    setMembers(false);
  });
  document.body.appendChild(scrim);
}

/**
 * The button that opens the conversation list.
 *
 * Put in the top bar, ahead of the channel name. The desktop has no such
 * control because both columns are always visible.
 */
function addMenuButton(): void {
  const bar = document.getElementById("topbar");
  if (!bar) return;

  const button = document.createElement("button");
  button.id = "navBtn";
  button.className = "vbtn";
  button.setAttribute("aria-label", "Conversations");
  button.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M3 6h18M3 12h18M3 18h18"/></svg>';

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setNav(!navOpen());
  });

  bar.insertBefore(button, bar.firstChild);

  // And one for the member list, which the desktop toggles from a button that
  // is already there — so this only adds the left one.
}

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
 * Swipe from the left edge to open, and anywhere to close.
 *
 * Only from the edge, so a swipe across a message — selecting text, or
 * scrolling a wide attachment — is not mistaken for a request to navigate.
 */
function swipeToOpen(): void {
  const EDGE = 24;
  const DISTANCE = 60;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;

    tracking = navOpen() || startX <= EDGE;
  }, { passive: true });

  document.addEventListener("touchend", (event) => {
    if (!tracking) return;
    tracking = false;

    const touch = event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Horizontal, or it is a scroll that happened to drift sideways.
    if (Math.abs(dx) < DISTANCE || Math.abs(dy) > Math.abs(dx)) return;

    if (dx > 0 && !navOpen()) setNav(true);
    else if (dx < 0 && navOpen()) setNav(false);
  }, { passive: true });
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
