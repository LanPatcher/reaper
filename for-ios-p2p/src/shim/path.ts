/**
 * `node:path`, POSIX-only.
 *
 * The paths here are keys in a virtual tree, not paths on a real filesystem —
 * see `fs.ts`. They are always separated by forward slashes and are always
 * relative to the app's data directory, so the platform-specific behaviour
 * Node's version carries is not just unnecessary, it would be wrong: a
 * `win32`-flavoured `join` would produce backslashes that the rest of this
 * treats as part of a filename.
 */

export function join(...parts: string[]): string {
  const joined = parts
    .filter((part) => part !== "")
    .join("/")
    .replace(/\/+/g, "/");

  return normalise(joined);
}

export function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  if (at === -1) return ".";
  if (at === 0) return "/";
  return path.slice(0, at);
}

export function basename(path: string, extension?: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (extension && name.endsWith(extension)) {
    return name.slice(0, name.length - extension.length);
  }
  return name;
}

export function extname(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at);
}

export function resolve(...parts: string[]): string {
  // No working directory to resolve against, so this is `join` with a leading
  // slash — enough for the callers, which only ever build paths downwards.
  const joined = join(...parts);
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/** Collapse `.` and `..` without touching the filesystem. */
function normalise(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }

  const joined = out.join("/");
  return absolute ? `/${joined}` : joined;
}

export const sep = "/";

export default { join, dirname, basename, extname, resolve, sep };
