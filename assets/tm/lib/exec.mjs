// Thin process helpers. Everything shells out to *absolute* binary paths so it
// works regardless of PATH (important inside Raycast, whose PATH is minimal).

import { spawn } from "node:child_process";

const OSASCRIPT = "/usr/bin/osascript";

/**
 * Run a binary with args. Never rejects on a non-zero exit — returns the exit
 * code and captured output so callers decide what a failure means.
 * @param {string} bin absolute path to the executable
 * @param {string[]} args
 * @param {{ input?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(bin, args = [], opts = {}) {
  const { input, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr + "\n[timed out]" });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err && err.message) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Escape a JS string into an AppleScript string literal, e.g.
 *   asLiteral('a "b" \\c')  ->  "\"a \\\"b\\\" \\\\c\""
 * @param {string} s
 * @returns {string}
 */
export function asLiteral(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Compile & run an AppleScript passed on stdin (avoids all argv-quoting pitfalls).
 * Throws with osascript's stderr on failure so callers can surface permission
 * errors. A timeout is reported LOUDLY (err.timedOut) so an enumeration that
 * ran out of time surfaces as "list may be incomplete" instead of vanishing.
 * @param {string} script
 * @param {{ timeoutMs?: number }} [opts] override the default shell-out timeout
 *   (enumeration passes a larger budget than the 8s default so a heavy machine
 *   with many tabs doesn't get its whole tab list wiped).
 * @returns {Promise<string>} trimmed stdout
 */
export async function osa(script, opts = {}) {
  const { code, stdout, stderr } = await run(OSASCRIPT, [], {
    input: script,
    timeoutMs: opts.timeoutMs,
  });
  if (code !== 0) {
    const timedOut = code === 124;
    const msg = timedOut
      ? "osascript timed out — the tab list may be incomplete"
      : (stderr || stdout || "osascript failed").trim();
    const err = new Error(msg);
    // -1743 == "Not authorized to send Apple events" (Automation permission).
    err.needsAutomationPermission = /-1743|not authoriz|assistive access/i.test(msg);
    err.timedOut = timedOut;
    // App not installed / not resolvable (e.g. iTerm absent but a process name
    // false-matched): -1728/-1708 "Can't get application", "isn't running".
    err.appMissing = /-1728|-1708|can.?t get application|isn.?t running|is not running/i.test(msg);
    throw err;
  }
  return stdout.trim();
}

/**
 * True if a process whose name contains `name` (case-insensitive) is running.
 * Uses pgrep so it works regardless of where the app is installed — the key to
 * detecting iTerm2 even when it lives outside /Applications (Setapp, MacPorts,
 * a custom folder). `pgrep -i` substring-matches, which `-x` does not do
 * reliably for GUI app process names.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function isProcessRunning(name) {
  const { code } = await run("/usr/bin/pgrep", ["-i", name], { timeoutMs: 3000 });
  return code === 0;
}
