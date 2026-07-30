// Path normalization so two spellings of the same folder always match:
//   ~/dev/x  ==  /Users/me/dev/x  ==  /var/…symlink…  ==  /private/var/…real…

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const HOME = os.homedir();

/**
 * Canonical form used for equality/grouping. Expands ~, resolves symlinks and
 * /var↔/private/var when the folder exists, strips trailing slash. Falls back
 * to a plain resolve when the path doesn't exist (e.g. opening a new folder).
 * @param {string} p
 * @returns {string}
 */
export function normalize(p) {
  if (!p) return p;
  let out = p.trim();
  if (out === "~") out = HOME;
  else if (out.startsWith("~/")) out = path.join(HOME, out.slice(2));
  out = path.resolve(out);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // Path may not exist yet — keep the resolved form.
  }
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Home-relative display form: /Users/me/dev/x -> ~/dev/x */
export function displayPath(p) {
  if (p === HOME) return "~";
  if (p && p.startsWith(HOME + "/")) return "~" + p.slice(HOME.length);
  return p;
}

/** Last path segment (folder name). */
export function baseName(p) {
  if (!p) return p;
  const b = path.basename(p);
  return b || p;
}

/** POSIX single-quote a string for safe use inside a shell command. */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
