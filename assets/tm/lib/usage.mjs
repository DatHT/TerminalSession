// Tiny persistent "frecency" store so the list can sort by how recently *you*
// used each folder through this tool, and so we can offer recently-used folders
// that no longer have a terminal open (the "open new" case in the UI).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(os.homedir(), ".terminal-session-manager");
const FILE = path.join(DIR, "usage.json");

/** @returns {Record<string, number>} normalized path -> last-used epoch ms */
export function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Record that a folder was just focused/opened. */
export function touch(folder) {
  if (!folder) return;
  const usage = readUsage();
  usage[folder] = Date.now();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(usage, null, 0));
  } catch {
    // Non-fatal: sorting just won't remember this use.
  }
}

/** Last-used timestamp for a folder, or 0 if never used through the tool. */
export function lastUsed(folder) {
  const usage = readUsage();
  return usage[folder] || 0;
}

/**
 * Recently-used folders, most recent first, excluding any in `exclude` (the
 * folders that currently have a terminal open) and any that no longer exist.
 *
 * The directory-existence check is BOUNDED: it uses async fs.stat raced against
 * a short timer, so a recent folder that now lives on a dead network mount
 * (SMB/NFS/sshfs/FUSE) can't block the whole Node process the way a synchronous
 * fs.statSync would — the same hang the cwd path was hardened against. We also
 * probe only the most-recent handful, never the entire store.
 * @param {Set<string>} exclude
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function recentPaths(exclude = new Set(), limit = 12) {
  const usage = readUsage();
  const candidates = Object.entries(usage)
    .filter(([p]) => !exclude.has(p))
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
    .slice(0, Math.max(limit * 3, limit)); // cap how many paths we ever stat

  const reachable = await Promise.all(candidates.map((p) => isReachableDir(p)));
  const out = [];
  for (let i = 0; i < candidates.length && out.length < limit; i++) {
    if (reachable[i]) out.push(candidates[i]);
  }
  return out;
}

/** True if `p` is a directory; resolves false after `timeoutMs` so a dead mount never blocks. */
async function isReachableDir(p, timeoutMs = 400) {
  let timer;
  const bail = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const check = fs.promises
    .stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
  try {
    return await Promise.race([check, bail]);
  } finally {
    clearTimeout(timer);
  }
}
