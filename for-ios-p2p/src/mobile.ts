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
  keepMenuButton();
  closeOnNavigation();
  closeOnEscape();
  longPressAsContextMenu();
  swipeToOpen();
  keepComposerAboveKeyboard();
}

/**
 * Put the menu button back if the interface removes it.
 *
 * This layer runs *before* the shared page's own script, and that script owns
 * the top bar — it rewrites the channel name, the call button and the search
 * button as the view changes. Anything grafted in beforehand is at the mercy
 * of whichever redraw comes next, and a button that vanishes on navigating to
 * a server is indistinguishable from a button that never worked.
 *
 * Watching rather than re-adding on a timer, because the gap between the
 * removal and the next tick is a window where the only way to open the
 * conversation list is a gesture the user may not know about.
 */
function keepMenuButton(): void {
  const bar = document.getElementById("topbar");
  if (!bar) return;

  const observer = new MutationObserver(() => {
    if (!document.getElementById("navBtn")) addMenuButton();
  });

  observer.observe(bar, { childList: true });
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
 * Swipe to open and close the conversation list.
 *
 * The first version of this decided everything at `touchend`: if the finger
 * had travelled far enough in the right direction, the panel snapped. It read
 * as unreliable, and the reasons are worth stating because they are the usual
 * ones for gesture code that looks correct.
 *
 *   - **Nothing moved during the drag.** With no feedback there is no way to
 *     tell a gesture that is being recognised from one that is being ignored,
 *     so a swipe that fell short felt like the app had missed it rather than
 *     like the user had not gone far enough.
 *
 *   - **Closing required a long drag from anywhere.** Sixty pixels leftward
 *     with the panel open — but the panel is what is under the finger, and it
 *     scrolls vertically, so the gesture was competing with the list.
 *
 *   - **A flick did not count.** Distance alone ignores speed, and a quick
 *     short flick is how most people actually dismiss a drawer.
 *
 * So this follows the finger, and decides on release by position *or* by
 * velocity. The panel is dragged with `--nav-drag`, which `mobile.css` applies
 * on top of the open and closed positions; the transition is suppressed while
 * a finger is down so the movement is one-to-one instead of chasing.
 */
function swipeToOpen(): void {
  /** How far in from the left edge a drag may start when closed. */
  const EDGE = 30;

  /** Past this fraction of the panel, release completes the gesture. */
  const COMMIT = 0.4;

  /** Pixels per millisecond that count as a flick regardless of distance. */
  const FLICK = 0.5;

  const root = document.documentElement;

  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let dragging = false;
  let decided = false;
  let width = 320;

  const panelWidth = () => {
    const side = document.getElementById("side");
    const rail = document.getElementById("rail");
    return (side?.getBoundingClientRect().width ?? 280) +
      (rail?.getBoundingClientRect().width ?? 62);
  };

  const drag = (offset: number) => {
    root.style.setProperty("--nav-drag", `${offset}px`);
  };

  const release = () => {
    root.classList.remove("nav-dragging");
    root.style.removeProperty("--nav-drag");
  };

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startAt = event.timeStamp;
    decided = false;

    // Opening starts at the edge. Closing starts anywhere, because when the
    // panel is open the whole screen belongs to it.
    dragging = navOpen() || startX <= EDGE;
    width = panelWidth();
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!dragging) return;

    const touch = event.touches[0];
    if (!touch) return;

    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Committed to horizontal, or abandoned, on the first movement that says
    // which it is. Deciding once stops a drag turning into a scroll halfway
    // through and leaving the panel stranded.
    if (!decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;

      decided = true;
      if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; }

      root.classList.add("nav-dragging");
    }

    // Clamped, so pulling further than the panel travels does not push it past
    // its own edge and leave a gap behind it.
    //
    // The two cases are different distances from the same rest position: open
    // means "already at zero, drag negative"; closed means "already at minus
    // one width, drag towards zero". `mobile.css` adds this to whichever
    // position the class says it is in, so both are simply an offset.
    drag(navOpen()
      ? Math.max(-width, Math.min(0, dx))
      : Math.min(width, Math.max(0, dx)));
  }, { passive: true });

  const finish = (event: TouchEvent) => {
    if (!dragging) return;
    dragging = false;

    if (!decided) { release(); return; }

    const touch = event.changedTouches[0];
    release();
    if (!touch) return;

    const dx = touch.clientX - startX;
    const speed = Math.abs(dx) / Math.max(1, event.timeStamp - startAt);
    const far = Math.abs(dx) > width * COMMIT;

    if (!far && speed < FLICK) return;

    if (dx > 0) setNav(true);
    else setNav(false);
  };

  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", finish, { passive: true });
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
