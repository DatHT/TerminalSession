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
 * @returns {Promise<Array<{app:string,windowId:number,tabId:string,tty:string,selected:boolean,frontmost:boolean}>>}
 */
export async function enumerate() {
  const script = `
    if application "Terminal" is not running then return ""
    tell application "Terminal"
      set out to ""
      repeat with w in windows
        set wid to id of w
        set fm to frontmost of w
        repeat with t in tabs of w
          set tt to ""
          try
            set tt to (tty of t)
          end try
          if tt is not "" then
            set out to out & wid & "|" & tt & "|" & (selected of t) & "|" & fm & linefeed
          end if
        end repeat
      end repeat
      return out
    end tell`;
  const raw = await osa(script);
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
  const script = `
    tell application "Terminal"
      set found to false
      repeat with w in windows
        if (id of w) is ${tab.windowId} then
          repeat with t in tabs of w
            try
              if (tty of t) is ${wantTty} then
                set selected of t to true
                set found to true
              end if
            end try
          end repeat
          try
            set frontmost of w to true
          end try
          try
            set index of w to 1
          end try
        end if
      end repeat
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
