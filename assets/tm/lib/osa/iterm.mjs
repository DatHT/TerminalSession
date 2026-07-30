// iTerm2 driver, addressed by bundle id so it works whether the app registers
// its scripting name as "iTerm" or "iTerm2". Sessions have a *stable* id, so we
// can always re-focus the exact tab.

import { osa, asLiteral } from "../exec.mjs";
import { shellQuote } from "../paths.mjs";

export const APP = "iTerm2";
const BUNDLE = 'application id "com.googlecode.iterm2"';

/**
 * Enumerate every open iTerm2 session (a session is a pane/tab). Returns raw
 * tabs without cwd; the engine resolves cwds for all apps in one pass.
 * @returns {Promise<Array<{app:string,windowId:number,tabId:string,sessionId:string,tty:string,selected:boolean,frontmost:boolean}>>}
 */
export async function enumerate() {
  const script = `
    if ${BUNDLE} is not running then return ""
    tell ${BUNDLE}
      if (count of windows) is 0 then return ""
      set curWinId to ""
      try
        set curWinId to (id of current window) as text
      end try
      set out to ""
      repeat with w in windows
        set wid to id of w
        set curSid to ""
        try
          set curSid to id of current session of current tab of w
        end try
        repeat with t in tabs of w
          repeat with s in sessions of t
            set sid to id of s
            set tt to ""
            try
              set tt to tty of s
            end try
            if tt is not "" then
              set out to out & wid & "|" & sid & "|" & tt & "|" & (sid is curSid) & "|" & ((wid as text) is curWinId) & linefeed
            end if
          end repeat
        end repeat
      end repeat
      return out
    end tell`;
  const raw = await osa(script);
  const tabs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [wid, sid, tty, sel, fm] = line.split("|");
    if (!sid || !tty) continue;
    tabs.push({
      app: APP,
      windowId: Number(wid),
      tabId: `iterm:${sid}`,
      sessionId: sid,
      tty,
      selected: sel === "true",
      frontmost: fm === "true",
    });
  }
  return tabs;
}

/**
 * Bring a specific session to the front by its stable id.
 * @param {{sessionId:string}} tab
 * @returns {Promise<boolean>}
 */
export async function focus(tab) {
  const want = asLiteral(tab.sessionId);
  const script = `
    tell ${BUNDLE}
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (id of s) is ${want} then
              select w
              select t
              select s
              activate
              return "true"
            end if
          end repeat
        end repeat
      end repeat
      return "false"
    end tell`;
  const out = await osa(script);
  return out === "true";
}

/**
 * Open a new iTerm2 window (default profile) cd'd into the folder.
 * @param {string} folder normalized absolute path
 */
export async function openNew(folder) {
  const cmd = asLiteral(`cd ${shellQuote(folder)} && clear`);
  const script = `
    tell ${BUNDLE}
      activate
      set w to (create window with default profile)
      tell current session of w to write text ${cmd}
    end tell`;
  await osa(script);
}
