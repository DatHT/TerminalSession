// Resolve each terminal tab's working directory from its TTY device.
//
// A terminal tab owns a TTY (e.g. /dev/ttys014). We find the process on that
// TTY whose current directory is the folder you're actually in, and read its
// cwd. That folder is:
//   1. the foreground process's cwd (what's currently reading the keyboard —
//      `claude`, a REPL, vim, …); those inherit and keep the tab's directory;
//   2. else the interactive SHELL's cwd (bash/zsh/…), which tracks every `cd`;
//   3. else any readable process on the TTY.
//
// Why not "the lowest pid on the tty" (the old heuristic)? On a long-uptime
// machine PIDs wrap, so a later-spawned helper (caffeinate, a git child) can
// hold a LOWER pid than the login shell — picking it gives the wrong folder or
// none. And the session's `login` process is root-owned (unreadable by lsof as
// the user) AND its cwd is stuck at $HOME, not the shell's pwd. So we identify
// the shell by NAME, and resolve over every pid on the tty, never by min-pid.
//
// Batched syscalls: one `ps` snapshot, then `lsof` in bounded-concurrency
// chunks (so one pid on a hung mount can't stall or truncate the whole batch).

import { run } from "./exec.mjs";
import { lightNormalize } from "./paths.mjs";

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";

// Interactive shells whose cwd == the tab's current directory. NOTE: `login`
// is deliberately excluded — it is root-owned and its cwd is $HOME, not pwd.
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "tcsh", "csh", "ksh", "dash"]);

/** Strip a leading /dev/ so "/dev/ttys014" and "ttys014" compare equal. */
function shortTty(tty) {
  return String(tty || "").replace(/^\/dev\//, "");
}

/** Basename of a command's argv[0], with a login shell's leading "-" removed. */
function cmdBase(command) {
  if (!command) return "";
  const first = command.trim().split(/\s+/)[0] || "";
  return first.replace(/^-/, "").split("/").pop() || "";
}

/**
 * Given every process on ONE tty, decide the order in which to try their cwds
 * (best folder candidate first) and which process names the tab. Pure, so it's
 * unit-testable in isolation. Priority:
 *   1. the foreground process (pid == tpgid) — what's reading the keyboard;
 *   2. the interactive shell — the nearest shell ancestor of the foreground
 *      process (its pwd IS the tab's folder), else the newest shell on the tty;
 *   3. any other process on the tty (last resort).
 * `login` and helpers like `caffeinate` are never treated as the shell (login
 * is root-owned/unreadable and its cwd is $HOME, not pwd).
 * @param {Array<{pid:number,ppid:number,tpgid:number,cmd:string}>} arr
 * @returns {{order:number[], labelPid:number}}
 */
export function orderCandidates(arr) {
  const pidOnTty = new Set(arr.map((p) => p.pid));
  const fg = arr.find((p) => p.pid === p.tpgid) || null;

  let shell = null;
  if (fg) {
    let cur = fg;
    for (let guard = 0; cur && guard < 64; guard++) {
      if (SHELLS.has(cmdBase(cur.cmd))) { shell = cur; break; }
      cur = pidOnTty.has(cur.ppid) ? arr.find((p) => p.pid === cur.ppid) : null;
    }
  }
  if (!shell) {
    const shells = arr.filter((p) => SHELLS.has(cmdBase(p.cmd)));
    if (shells.length) shell = shells.reduce((a, b) => (b.pid > a.pid ? b : a));
  }

  const order = [];
  if (fg) order.push(fg.pid);
  if (shell && !order.includes(shell.pid)) order.push(shell.pid);
  for (const p of arr) if (!order.includes(p.pid)) order.push(p.pid);

  const labelPid = (fg || shell || arr[0]).pid;
  return { order, labelPid };
}

/**
 * @param {string[]} ttys e.g. ["/dev/ttys014", "ttys011"]
 * @returns {Promise<{cwds: Map<string,{cwd:string, proc:string|null}>, warnings: string[]}>}
 *   short-tty -> {cwd, process label}, plus any non-fatal warnings (timeouts)
 *   the caller should surface so a partial result is never silent.
 */
export async function resolveCwds(ttys) {
  const warnings = [];
  const wanted = new Set(ttys.map(shortTty).filter(Boolean));
  const cwds = new Map();
  if (wanted.size === 0) return { cwds, warnings };

  // 1) One ps snapshot: pid, ppid, foreground-pgid, tty, and full command.
  const ps = await run(PS, ["-A", "-o", "pid=,ppid=,tpgid=,tty=,command="], { timeoutMs: 10000 });
  if (ps.code === 124) {
    warnings.push("process list timed out — some tabs may be unresolved");
  }

  /** @type {Map<string, Array<{pid:number, ppid:number, tpgid:number, cmd:string}>>} */
  const byTty = new Map();
  // pid, ppid, tpgid (may be -1), tty, command(rest).
  const re = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/;
  for (const line of ps.stdout.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const tty = m[4];
    if (tty === "??" || tty === "?" || !wanted.has(tty)) continue;
    let arr = byTty.get(tty);
    if (!arr) byTty.set(tty, (arr = []));
    arr.push({ pid: Number(m[1]), ppid: Number(m[2]), tpgid: Number(m[3]), cmd: m[5] });
  }

  // 2) Resolve the cwd of EVERY process on a wanted tty (chunked lsof). Doing
  //    them all — not just fg+shell — means a tab is only unresolvable if none
  //    of its processes has a readable cwd.
  const allPids = [];
  for (const [, arr] of byTty) for (const p of arr) allPids.push(p.pid);
  if (allPids.length === 0) return { cwds, warnings };
  const { map: pidCwd, timedOut } = await lsofCwds(allPids);
  if (timedOut) {
    warnings.push("directory lookup timed out — some tabs may be unresolved");
  }

  // 3) Per tty, pick the folder in priority order and label by what's running.
  for (const tty of wanted) {
    const arr = byTty.get(tty);
    if (!arr || arr.length === 0) continue;

    const { order, labelPid } = orderCandidates(arr);

    let raw = null;
    for (const pid of order) {
      const c = pidCwd.get(pid);
      if (c) { raw = c; break; }
    }
    if (!raw) continue; // truly unresolvable; surfaced as a count by the caller

    const labelRec = arr.find((p) => p.pid === labelPid) || arr[0];
    cwds.set(tty, { cwd: lightNormalize(raw), proc: procLabel(labelRec.cmd) });
  }
  return { cwds, warnings };
}

/**
 * Short human label for what's running in a tab, derived from the foreground
 * process command: "claude", "shell", "vim", "hermes", "node", …
 * @param {string|undefined} command
 * @returns {string|null}
 */
function procLabel(command) {
  if (!command) return null;
  const cmd = command.trim();
  if (!cmd) return null;
  const first = cmd.split(/\s+/)[0];
  let base = first.replace(/^-/, ""); // login shells appear as "-bash"
  base = base.split("/").pop() || base;
  const shells = new Set(["bash", "zsh", "fish", "sh", "tcsh", "csh", "ksh", "dash"]);
  if (shells.has(base)) return "shell";
  // A runtime running a script → prefer the script's name (e.g. hermes).
  const runners = new Set(["node", "python", "python3", "ruby", "deno", "bun", "php"]);
  if (runners.has(base)) {
    const args = cmd.split(/\s+/).slice(1).filter((a) => !a.startsWith("-"));
    const script = args.find((a) => a.includes("/") || /\.\w+$/.test(a));
    if (script) {
      const sbase = (script.split("/").pop() || "").replace(/\.(mjs|cjs|js|ts|py|rb)$/, "");
      if (sbase) return sbase;
    }
  }
  return base || null;
}

/**
 * pid -> cwd path, for many pids at once. Runs lsof in bounded-concurrency
 * chunks with a per-chunk timeout, and lsof's own `-S 2` stat timeout, so a
 * single process whose cwd sits on a hung/slow mount can only stall its own
 * small chunk (≤2s) instead of SIGKILLing one giant lsof and silently dropping
 * every pid it hadn't reached yet.
 * @param {number[]} pids
 * @returns {Promise<{map: Map<number,string>, timedOut: boolean}>}
 */
async function lsofCwds(pids) {
  const map = new Map();
  let timedOut = false;
  if (pids.length === 0) return { map, timedOut };

  const CHUNK = 48;
  const CONCURRENCY = 4;
  const chunks = [];
  for (let i = 0; i < pids.length; i += CHUNK) chunks.push(pids.slice(i, i + CHUNK));

  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const my = chunks[next++];
      // -w suppress warnings, -n/-P skip host/port name lookups, -S 2 bounds
      // each stat/readlink to 2s, -a -d cwd = only the cwd descriptor.
      const { code, stdout } = await run(
        LSOF,
        ["-w", "-n", "-P", "-S", "2", "-a", "-d", "cwd", "-p", my.join(","), "-Fpn"],
        { timeoutMs: 5000 }
      );
      if (code === 124) timedOut = true;
      // Note: lsof exits non-zero (1) whenever any pid has no cwd descriptor —
      // that's normal, so we always parse whatever it printed.
      let cur = null;
      for (const line of stdout.split("\n")) {
        if (line[0] === "p") cur = Number(line.slice(1));
        else if (line[0] === "n" && cur != null) map.set(cur, line.slice(1));
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker)
  );
  return { map, timedOut };
}
