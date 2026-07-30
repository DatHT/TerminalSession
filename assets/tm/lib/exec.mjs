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
 * Throws with osascript's stderr on failure so callers can surface permission errors.
 * @param {string} script
 * @returns {Promise<string>} trimmed stdout
 */
export async function osa(script) {
  const { code, stdout, stderr } = await run(OSASCRIPT, [], { input: script });
  if (code !== 0) {
    const msg = (stderr || stdout || "osascript failed").trim();
    const err = new Error(msg);
    // -1743 == "Not authorized to send Apple events" (Automation permission).
    err.needsAutomationPermission = /-1743|not authoriz|assistive access/i.test(msg);
    throw err;
  }
  return stdout.trim();
}
