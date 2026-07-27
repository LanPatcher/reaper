import { contextBridge, ipcRenderer } from "electron";

import { version } from "../../package.json";

contextBridge.exposeInMainWorld("native", {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    desktop: () => version,
  },

  minimise: () => ipcRenderer.send("minimise"),
  maximise: () => ipcRenderer.send("maximise"),
  close: () => ipcRenderer.send("close"),

  setBadgeCount: (count: number) => ipcRenderer.send("setBadgeCount", count),

  /**
   * Raise a desktop notification.
   *
   * There is no field for the message. That is not an oversight — a Windows
   * notification is drawn by the shell, shown over the lock screen and kept in
   * the Action Centre after the app has closed, so anything put in it has left
   * the app's control. Who and where is enough to decide whether to look.
   */
  notify: (request: {
    who: string;
    where: string;
    direct?: boolean;
    go?: unknown;
  }) => ipcRenderer.send("notify", request),

  /**
   * Called when one of them is clicked, with whatever `go` it was given.
   *
   * Replaces any previous listener rather than adding to it, so a reload does
   * not leave two handlers racing to open different conversations.
   */
  onNotifyClick: (handler: (go: unknown) => void) => {
    ipcRenderer.removeAllListeners("notifyClick");
    ipcRenderer.on("notifyClick", (_, go) => handler(go));
  },

  /**
   * Save a remote file to disk.
   *
   * The web client's download buttons are `<a download target="_blank">`,
   * which is the correct thing on the web and useless here: `download` is
   * ignored for cross-origin links, and `target="_blank"` is routed to the
   * system browser. The user gets a browser tab instead of a file. This gives
   * the renderer a way to say "save this" and mean it.
   */
  downloadFile: (url: string) => ipcRenderer.send("downloadFile", url),

  onceScreenPicker: (
    onScreenPick: (
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
      }[],
    ) => void,
  ) => {
    const eventName = "screenPicker";
    ipcRenderer.removeAllListeners(eventName);
    ipcRenderer.once(eventName, (_, sources) => onScreenPick(sources));
  },
  screenPickerCallback: (idx: number, audio: boolean) =>
    ipcRenderer.send("screenPickerCallback", idx, audio),
});
