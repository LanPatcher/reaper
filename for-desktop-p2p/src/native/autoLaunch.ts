import AutoLaunch from "auto-launch";

import { ipcMain } from "electron";

/**
 * The "start when I log in" entry.
 *
 * The name is what appears in Task Manager's Startup tab and what the registry
 * key is called, so it has to be this app's name — it said "Stoat" for as long
 * as this was a fork, which meant an entry nobody recognised pointing at an
 * executable they had never heard of.
 *
 * `isHidden` asks the app to come up in the tray rather than throwing a window
 * in front of somebody who is trying to log in. Whether it stays there is the
 * `startMinimisedToTray` setting; this only covers the launch that the system
 * performs on its own.
 */
export const autoLaunch = new AutoLaunch({
  name: "Reaper",
  isHidden: true,
});

/**
 * The entry this app used to write.
 *
 * Renaming leaves the old one behind, pointing at an executable that may not
 * exist any more — so Windows shows a startup item that fails silently every
 * login. Removed on first run rather than left for somebody to find.
 */
export const previousLaunch = new AutoLaunch({ name: "Mayhem", isHidden: true });

ipcMain.handle("getAutostart", async () => {
  // Clean up after the rename, and carry the setting across: somebody who had
  // this switched on should not have it quietly turn itself off.
  try {
    if (await previousLaunch.isEnabled()) {
      await previousLaunch.disable();
      if (!(await autoLaunch.isEnabled())) await autoLaunch.enable();
    }
  } catch {
    // A startup entry that cannot be read is not a reason to fail the call.
  }

  const enabled = await autoLaunch.isEnabled();
  return enabled;
});

ipcMain.handle("setAutostart", async (_event, state: boolean) => {
  if (state) {
    await autoLaunch.enable();
    console.log("Received new configuration autoStart: true");
  } else {
    await autoLaunch.disable();
    console.log("Received new configuration autoStart: false");
  }

  const enabled = await autoLaunch.isEnabled();
  return enabled;
});
