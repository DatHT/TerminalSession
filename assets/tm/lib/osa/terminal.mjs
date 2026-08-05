// Terminal.app driver. Tabs have no stable id in AppleScript, so we identify a
// tab by (window id + tty) — the tty is stable for the life of the tab, even if
// tab indexes shift.

import { osa, asLiteral } from "../exec.mjs";
import { shellQuote } from "../paths.mjs";

export const APP = "Terminal";

function shortTty(tty) {
  return String(tty || "").replace(/^\/dev\//, "");
}

/**
 * Enumerate every open Terminal tab. Returns raw tabs *without* cwd (the engine
 * resolves cwds for all apps in one batched pass).
 *
 * Speed & safety: properties are read in BULK (`tty of tabs of w` is one Apple
 * event per window, not one per tab), which keeps a machine with many tabs well
 * under the timeout instead of making O(tabs) cross-process round-trips. Every
 * per-window and per-item read is wrapped in `try` so one odd window/tab (mid
 * close, a restored session) is skipped instead of aborting the whole scan; if
 * a bulk read throws we fall back to reading that window's tabs one by one.
 * @returns {Promise<Array<{app:string,windowId:number,tabId:string,tty:string,selected:boolean,frontmost:boolean}>>}
 */
export async function enumerate() {
  const script = `
    if application "Terminal" is not running then return ""
    set AppleScript's text item delimiters to linefeed
    tell application "Terminal"
      set rows to {}
      repeat with w in windows
        set wid to -1
        try
          set wid to id of w
        end try
        set fm to false
        try
          set fm to frontmost of w
        end try
        set ttys to {}
        set sels to {}
        try
          set ttys to tty of tabs of w
          set sels to selected of tabs of w
        on error
          set ttys to {}
          set sels to {}
          repeat with t in tabs of w
            set tt2 to ""
            set sv2 to false
            try
              set tt2 to tty of t
              set sv2 to selected of t
            end try
            set end of ttys to tt2
            set end of sels to sv2
          end repeat
        end try
        repeat with i from 1 to (count of ttys)
          set tt to item i of ttys
          if tt is not missing value and tt is not "" then
            set sv to false
            try
              set sv to item i of sels
            end try
            set end of rows to (wid as text) & "|" & tt & "|" & (sv as text) & "|" & (fm as text)
          end if
        end repeat
      end repeat
      return rows as text
    end tell`;
  const raw = await osa(script, { timeoutMs: 15000 });
  const tabs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [wid, tty, sel, fm] = line.split("|");
    if (!tty) continue;
    tabs.push({
      app: APP,
      windowId: Number(wid),
      tabId: `terminal:${wid}:${shortTty(tty)}`,
      tty,
      selected: sel === "true",
      frontmost: fm === "true",
    });
  }
  return tabs;
}

/**
 * Bring a specific tab to the front. Re-resolves the tab by tty at focus time.
 * @param {{windowId:number, tty:string}} tab
 * @returns {Promise<boolean>} whether a matching tab was found
 */
export async function focus(tab) {
  const wantTty = asLiteral(tab.tty);
  // The window is addressed BY ID (`window id N`), never through a
  // `repeat with w in windows` loop variable: those are INDEX references, and
  // bringing a window forward reorders the window list — after which the loop
  // variable silently resolves to a DIFFERENT window and the wrong terminal
  // gets fronted (confirmed live: fronting index-5 made `w` point at the old
  // index-5 occupant). By-id references are immune to reordering.
  const script = `
    tell application "Terminal"
      set found to false
      try
        set w to window id ${tab.windowId}
        repeat with t in tabs of w
          try
            if (tty of t) is ${wantTty} then
              set selected of t to true
              set found to true
              exit repeat
            end if
          end try
        end repeat
        set index of w to 1
      end try
      activate
      return found
    end tell`;
  const out = await osa(script);
  return out === "true";
}

/**
 * Open a brand-new Terminal window cd'd into the folder.
 * @param {string} folder normalized absolute path
 */
export async function openNew(folder) {
  const cmd = asLiteral(`cd ${shellQuote(folder)} && clear`);
  const script = `
    tell application "Terminal"
      activate
      do script ${cmd}
    end tell`;
  await osa(script);
}
