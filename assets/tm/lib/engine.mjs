// Orchestration: enumerate both terminal apps, resolve folders, group them, and
// implement the core "reuse existing vs. open new" behavior. This module is the
// single source of truth used by both the CLI and the Raycast extension.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import * as terminal from "./osa/terminal.mjs";
import * as iterm from "./osa/iterm.mjs";
import { resolveCwds } from "./cwd.mjs";
import { normalize, displayPath, baseName } from "./paths.mjs";
import { touch, lastUsed, recentPaths } from "./usage.mjs";

/**
 * @typedef {Object} Tab
 * @property {"iTerm2"|"Terminal"} app
 * @property {number} windowId
 * @property {string} tabId       globally-unique ("iterm:<sid>" / "terminal:<wid>:<tty>")
 * @property {string} [sessionId] iTerm only
 * @property {string} tty
 * @property {boolean} selected
 * @property {boolean} frontmost
 * @property {string|null} cwd    normalized working directory
 * @property {string|null} proc   foreground process label ("claude"/"shell"/…)
 *
 * @typedef {Object} FolderGroup
 * @property {string} path        normalized absolute path
 * @property {string} name        folder (basename)
 * @property {string} display     home-relative path for display
 * @property {Tab[]} tabs
 * @property {("iTerm2"|"Terminal")[]} apps  distinct apps with a tab here
 * @property {boolean} frontmost  any tab is in the frontmost window
 * @property {number} lastUsed    epoch ms, from the usage store
 */

const shortTty = (t) => String(t || "").replace(/^\/dev\//, "");

/** Is iTerm2 installed on disk? */
export function itermInstalled() {
  return [
    "/Applications/iTerm.app",
    path.join(os.homedir(), "Applications/iTerm.app"),
  ].some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** Which app to use when opening a brand-new terminal (confirmed default: iTerm2 if present). */
export function defaultApp() {
  return itermInstalled() ? "iTerm2" : "Terminal";
}

/**
 * Enumerate all tabs from both apps and attach each one's working directory.
 * @returns {Promise<{ tabs: Tab[], errors: Array<{app:string,message:string,needsAutomationPermission:boolean}> }>}
 */
export async function scanTabs() {
  const errors = [];
  const collect = async (mod) => {
    try {
      return await mod.enumerate();
    } catch (e) {
      errors.push({
        app: mod.APP,
        message: String(e && e.message ? e.message : e),
        needsAutomationPermission: !!(e && e.needsAutomationPermission),
      });
      return [];
    }
  };

  // Only scan iTerm2 if it's actually installed — avoids a spurious error on
  // machines that don't have it.
  const [tTabs, iTabs] = await Promise.all([
    collect(terminal),
    itermInstalled() ? collect(iterm) : Promise.resolve([]),
  ]);
  const tabs = [...tTabs, ...iTabs];

  const cwds = await resolveCwds(tabs.map((t) => t.tty));
  for (const t of tabs) {
    const info = cwds.get(shortTty(t.tty));
    t.cwd = info ? info.cwd : null;
    t.proc = info ? info.proc : null;
  }

  return { tabs, errors };
}

/**
 * Full listing for the UI: folders that have a terminal open (grouped), plus
 * recently-used folders that don't.
 * @returns {Promise<{ groups: FolderGroup[], recent: {path:string,name:string,display:string}[], errors: any[] }>}
 */
export async function listSessions() {
  const { tabs, errors } = await scanTabs();

  /** @type {Map<string, FolderGroup>} */
  const byPath = new Map();
  for (const t of tabs) {
    if (!t.cwd) continue; // couldn't resolve a folder — can't group it
    let g = byPath.get(t.cwd);
    if (!g) {
      byPath.set(
        t.cwd,
        (g = {
          path: t.cwd,
          name: baseName(t.cwd),
          display: displayPath(t.cwd),
          tabs: [],
          apps: [],
          frontmost: false,
          lastUsed: lastUsed(t.cwd),
        })
      );
    }
    g.tabs.push(t);
    if (!g.apps.includes(t.app)) g.apps.push(t.app);
    if (t.frontmost) g.frontmost = true;
  }

  const groups = [...byPath.values()];
  // Order tabs inside a group: frontmost, then selected, then stable by id.
  for (const g of groups) {
    g.tabs.sort(
      (a, b) =>
        Number(b.frontmost) - Number(a.frontmost) ||
        Number(b.selected) - Number(a.selected) ||
        a.tabId.localeCompare(b.tabId)
    );
  }
  // Order groups: most-recently used first, then frontmost, then A–Z.
  groups.sort(
    (a, b) =>
      b.lastUsed - a.lastUsed ||
      Number(b.frontmost) - Number(a.frontmost) ||
      a.name.localeCompare(b.name)
  );

  const openPaths = new Set(groups.map((g) => g.path));
  const recent = recentPaths(openPaths, 12).map((p) => ({
    path: p,
    name: baseName(p),
    display: displayPath(p),
  }));

  return { groups, recent, errors };
}

/** Pick the most sensible tab to focus within a group. */
export function bestTab(group) {
  return group.tabs[0]; // already sorted frontmost > selected > stable
}

/**
 * Focus a specific tab by its id (needs the tab's full record for app dispatch).
 * @param {Tab} tab
 * @returns {Promise<boolean>}
 */
export async function focusTab(tab) {
  const ok = tab.app === "iTerm2" ? await iterm.focus(tab) : await terminal.focus(tab);
  if (ok && tab.cwd) touch(tab.cwd);
  return ok;
}

/**
 * Focus an already-open terminal for a folder, if one exists.
 * @param {string} folder
 * @returns {Promise<{focused:boolean, group?:FolderGroup}>}
 */
export async function focusFolder(folder) {
  const target = normalize(folder);
  const { groups } = await listSessions();
  const group = groups.find((g) => g.path === target);
  if (!group) return { focused: false };
  const ok = await focusTab(bestTab(group));
  return { focused: ok, group };
}

/**
 * Open a brand-new terminal (new window) cd'd into the folder.
 * @param {string} folder
 * @param {{app?: "iTerm2"|"Terminal"}} [opts]
 */
export async function openFolder(folder, opts = {}) {
  const target = normalize(folder);
  const app = opts.app || defaultApp();
  if (app === "iTerm2") await iterm.openNew(target);
  else await terminal.openNew(target);
  touch(target);
  return { app, path: target };
}

/**
 * THE CORE BEHAVIOR. Focus the existing terminal for a folder; only open a new
 * one when none exists.
 * @param {string} folder
 * @param {{app?: "iTerm2"|"Terminal"}} [opts]
 * @returns {Promise<{action:"focused"|"opened", app?:string, path:string}>}
 */
export async function openOrFocus(folder, opts = {}) {
  const target = normalize(folder);
  const found = await focusFolder(target);
  if (found.focused) return { action: "focused", path: target };
  const opened = await openFolder(target, opts);
  return { action: "opened", app: opened.app, path: target };
}

/** Human-readable diagnostics for troubleshooting. */
export async function doctor() {
  const { tabs, errors } = await scanTabs();
  const byApp = { iTerm2: 0, Terminal: 0 };
  const unresolved = [];
  for (const t of tabs) {
    byApp[t.app] = (byApp[t.app] || 0) + 1;
    if (!t.cwd) unresolved.push(`${t.app} ${t.tty}`);
  }
  return {
    node: process.version,
    itermInstalled: itermInstalled(),
    defaultApp: defaultApp(),
    tabsFound: tabs.length,
    byApp,
    foldersResolved: tabs.filter((t) => t.cwd).length,
    unresolved,
    errors,
  };
}
