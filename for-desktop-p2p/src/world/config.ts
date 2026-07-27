import { contextBridge, ipcRenderer } from "electron";

let config: DesktopConfig;

ipcRenderer.on("config", (_, data) => (config = data));

contextBridge.exposeInMainWorld("desktopConfig", {
  /** The last pushed copy. Undefined until the main process has sent one. */
  get: () => config,

  /**
   * Ask for the settings directly.
   *
   * `get()` is whatever was last pushed, which on a freshly opened panel may
   * be nothing at all. This always answers.
   */
  read: () => ipcRenderer.invoke("config:read") as Promise<DesktopConfig>,

  set: (config: Partial<DesktopConfig>) => ipcRenderer.send("config", config),
  getAutostart() {
    return ipcRenderer.invoke("getAutostart") as Promise<boolean>;
  },
  setAutostart(value: boolean) {
    return ipcRenderer.invoke("setAutostart", value) as Promise<boolean>;
  },
});
