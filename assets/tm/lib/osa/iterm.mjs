// iTerm2 driver, addressed by bundle id so it works whether the app registers
// its scripting name as "iTerm" or "iTerm2". Sessions have a *stable* id, so we
// can always re-focus the exact tab.

import { osa, asLiteral } from "../exec.mjs";
import { shellQuote } from "../paths.mjs";

export const APP = "iTerm2";
const BUNDLE = 'application id "com.googlecode.iterm2"';

/**
 * Enumerate every open iTerm2 session (a session is a pane/tab), INCLUDING
 * buried sessions. Returns raw tabs without cwd; the engine resolves cwds for
 * all apps in one pass.
 *
 * Speed & safety: ids and ttys are read in BULK (`tty of sessions of t` is one
 * Apple event per tab, not one per pane), keeping a window full of split panes
 * well under the timeout. Every per-window / per-tab read is wrapped in `try`
 * so one odd session can't abort the whole scan; if a bulk read throws we fall
 * back to reading that tab's sessions one by one.
 * @returns {Promise<Array<{app:string,windowId:number,tabId:string,sessionId:string,tty:string,selected:boolean,frontmost:boolean}>>}
 */
export async function enumerate() {
  const script = `
    if ${BUNDLE} is not running then return ""
    set AppleScript's text item delimiters to linefeed
    tell ${BUNDLE}
      set curWinId to ""
      try
        set curWinId to (id of current window) as text
      end try
      set rows to {}
      repeat with w in windows
        set wid to -1
        try
          set wid to id of w
        end try
        set curSid to ""
        try
          set curSid to (id of current session of current tab of w) as text
        end try
        repeat with t in tabs of w
          set sids to {}
          set ttys to {}
          try
            set sids to id of sessions of t
            set ttys to tty of sessions of t
          on error
            set sids to {}
            set ttys to {}
            repeat with s in sessions of t
              set sid2 to ""
              set tt2 to ""
              try
                set sid2 to (id of s) as text
                set tt2 to tty of s
              end try
              set end of sids to sid2
              set end of ttys to tt2
            end repeat
          end try
          repeat with i from 1 to (count of sids)
            set sid to item i of sids
            set tt to ""
            try
              set tt to item i of ttys
            end try
            if sid is not missing value and (sid as text) is not "" and tt is not missing value and tt is not "" then
              set isSel to ((sid as text) is equal to curSid)
              set isFront to ((wid as text) is equal to curWinId)
              set end of rows to (wid as text) & "|" & (sid as text) & "|" & tt & "|" & (isSel as text) & "|" & (isFront as text)
            end if
          end repeat
        end repeat
      end repeat
      -- Buried sessions (hidden, not in any window) — otherwise invisible.
      try
        repeat with s in buried sessions
          set sid to ""
          set tt to ""
          try
            set sid to (id of s) as text
            set tt to tty of s
          end try
          if sid is not "" and tt is not missing value and tt is not "" then
            set end of rows to "-1|" & sid & "|" & tt & "|false|false"
          end if
        end repeat
      end try
      return rows as text
    end tell`;
  const raw = await osa(script, { timeoutMs: 15000 });
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
 * Bring a specific session to the front by its stable id. Handles buried
 * sessions too (they must be revealed before they can be selected).
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
      -- Not in any window: try to reveal a buried session with this id.
      try
        repeat with s in buried sessions
          if (id of s) is ${want} then
            reveal s
            activate
            return "true"
          end if
        end repeat
      end try
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
