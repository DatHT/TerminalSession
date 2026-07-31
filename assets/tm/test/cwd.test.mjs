// Unit tests for the cwd pid-selection logic — the fix for tabs going missing
// or mis-filed when a helper (caffeinate) outranks the login shell under PID
// wraparound, or when the foreground process is root-owned/unreadable.
//
// Run: node assets/tm/test/cwd.test.mjs

import assert from "node:assert";
import { orderCandidates } from "../lib/cwd.mjs";
import { lightNormalize } from "../lib/paths.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("FAIL  " + name + "\n      " + (e && e.message));
    process.exitCode = 1;
  }
}

// The exact ttys012 process table observed on this machine (PID wraparound:
// caffeinate 13177 has a LOWER pid than the login shell 31667).
const ttys012 = [
  { pid: 13177, ppid: 31722, tpgid: 31722, cmd: "caffeinate -i -t 300" },
  { pid: 31667, ppid: 1379, tpgid: 31722, cmd: "login -pfl huynhdat /bin/bash -c exec -la bash /bin/bash" },
  { pid: 31668, ppid: 31667, tpgid: 31722, cmd: "-bash" },
  { pid: 31722, ppid: 31668, tpgid: 31722, cmd: "claude" },
];

test("foreground (claude) is tried first", () => {
  const { order, labelPid } = orderCandidates(ttys012);
  assert.strictEqual(order[0], 31722, "fg claude should be first");
  assert.strictEqual(labelPid, 31722, "label should be the foreground process");
});

test("fallback picks the interactive shell (-bash), NEVER caffeinate or login", () => {
  const { order } = orderCandidates(ttys012);
  // If the foreground cwd were unreadable, the NEXT candidate must be -bash.
  assert.strictEqual(order[1], 31668, "second choice must be -bash, not caffeinate/login");
  // caffeinate (the old Math.min winner) and root-owned login must rank AFTER.
  assert.ok(order.indexOf(31668) < order.indexOf(13177), "-bash before caffeinate");
  assert.ok(order.indexOf(31668) < order.indexOf(31667), "-bash before login");
});

test("old Math.min heuristic would have been WRONG here (regression guard)", () => {
  const minPid = Math.min(...ttys012.map((p) => p.pid));
  assert.strictEqual(minPid, 13177, "min pid is caffeinate — proves the old bug");
  const { order } = orderCandidates(ttys012);
  assert.notStrictEqual(order[1], minPid, "we must NOT fall back to the min pid");
});

test("root/sudo foreground: shell still found, fg still tried first", () => {
  // sudo runs a root process as the foreground; login shell is -zsh.
  const arr = [
    { pid: 500, ppid: 1, tpgid: 900, cmd: "login -pfl me /bin/zsh" },
    { pid: 501, ppid: 500, tpgid: 900, cmd: "-zsh" },
    { pid: 900, ppid: 501, tpgid: 900, cmd: "sudo systemctl-ish-root-thing" },
  ];
  const { order, labelPid } = orderCandidates(arr);
  assert.strictEqual(order[0], 900, "root fg tried first (it may be unreadable, handled upstream)");
  assert.strictEqual(order[1], 501, "then the readable -zsh shell (its pwd == the folder)");
  assert.strictEqual(labelPid, 900, "label is the foreground (sudo) process");
});

test("no foreground (tpgid orphaned): newest shell chosen", () => {
  const arr = [
    { pid: 100, ppid: 1, tpgid: -1, cmd: "login -pfl me /bin/bash" },
    { pid: 101, ppid: 100, tpgid: -1, cmd: "-bash" },
  ];
  const { order, labelPid } = orderCandidates(arr);
  assert.strictEqual(order[0], 101, "the -bash shell is the best candidate");
  assert.strictEqual(labelPid, 101, "label falls back to the shell when there is no fg");
});

test("nested shells: nearest shell ancestor of fg wins", () => {
  const arr = [
    { pid: 200, ppid: 1, tpgid: 400, cmd: "-zsh" },
    { pid: 300, ppid: 200, tpgid: 400, cmd: "zsh" }, // a subshell
    { pid: 400, ppid: 300, tpgid: 400, cmd: "vim file" },
  ];
  const { order } = orderCandidates(arr);
  assert.strictEqual(order[0], 400, "fg vim first");
  assert.strictEqual(order[1], 300, "nearest shell ancestor (the subshell) next, not the outer zsh");
});

test("single-process shell tab: fg == shell", () => {
  const arr = [{ pid: 10, ppid: 2, tpgid: 10, cmd: "/bin/bash --rcfile x" }];
  const { order, labelPid } = orderCandidates(arr);
  assert.deepStrictEqual(order, [10]);
  assert.strictEqual(labelPid, 10);
});

test("lightNormalize canonicalizes without touching the filesystem", () => {
  assert.strictEqual(lightNormalize("/a/b/"), "/a/b");
  assert.strictEqual(lightNormalize("/"), "/");
  assert.strictEqual(lightNormalize("/x/y/z/../.."), "/x");
});

console.log(`\n${passed} passed`);
