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
 * @param {Set<string>} exclude
 * @param {number} limit
 * @returns {string[]}
 */
export function recentPaths(exclude = new Set(), limit = 12) {
  const usage = readUsage();
  return Object.entries(usage)
    .filter(([p]) => !exclude.has(p))
    .filter(([p]) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}
