/**
 * A stand-in for `@capacitor/filesystem`, for the tests.
 *
 * `fs.test.ts` is about the shim, not about Capacitor, so the plugin is
 * replaced with something that behaves the way it does in the two respects
 * that actually catch bugs:
 *
 *   - **Data crosses as base64.** Every file here is either an encrypted frame
 *     or a content-addressed blob, so an encoding that mangles high bytes
 *     would corrupt everything — and only on the second launch, once the data
 *     is being read back rather than served from memory.
 *   - **A write fails if its parent directory is missing.** The real plugin
 *     refuses, and the shim has to create the folder first. Faking a
 *     filesystem that accepts anything would hide exactly that.
 *
 * `scripts/shim.mjs` aliases the plugin to this module when building the test,
 * so `fs.ts` and the test see the same instance and the test can look at what
 * actually reached the "disk".
 */

/** Path to base64 contents. */
export const disk = new Map<string, string>();

/** Directories that exist. */
export const folders = new Set<string>(["reaper"]);

export const Directory = { Data: "DATA" } as const;
export const Encoding = { UTF8: "utf8" } as const;

export const Filesystem = {
  async mkdir({ path, recursive }: { path: string; recursive?: boolean }) {
    // Throws when it is already there, exactly as the plugin does — which is
    // why every caller in `fs.ts` swallows it.
    if (folders.has(path)) throw new Error("Directory exists");

    if (!recursive) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent && !folders.has(parent)) throw new Error("Parent missing");
    }

    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  },

  async readdir({ path }: { path: string }) {
    if (!folders.has(path)) throw new Error("Not found");

    const prefix = `${path}/`;
    const names = new Map<string, "file" | "directory">();

    for (const known of disk.keys()) {
      if (!known.startsWith(prefix)) continue;

      const rest = known.slice(prefix.length);
      const slash = rest.indexOf("/");

      if (slash === -1) names.set(rest, "file");
      else names.set(rest.slice(0, slash), "directory");
    }

    return { files: [...names].map(([name, type]) => ({ name, type })) };
  },

  async readFile({ path }: { path: string }) {
    const data = disk.get(path);
    if (data === undefined) throw new Error("Not found");
    return { data };
  },

  async writeFile({ path, data }: { path: string; data: string }) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && !folders.has(parent)) throw new Error("Parent missing");
    disk.set(path, data);
  },

  async deleteFile({ path }: { path: string }) {
    if (!disk.delete(path)) throw new Error("Not found");
  },
};
