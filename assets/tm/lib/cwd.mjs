// Resolve each terminal tab's working directory from its TTY device.
//
// A terminal tab owns a TTY (e.g. /dev/ttys014). We find the tab's *foreground*
// process (the one currently reading the keyboard) and read its cwd. That's the
// folder you're actually in — correct even when `claude`, a REPL, or python is
// running in the tab, because those inherit and keep the tab's directory.
//
// Two batched syscalls total, regardless of how many tabs are open:
//   ps   -> tty -> candidate pids  (foreground first, shell as fallback)
//   lsof -> pid -> cwd

import { run } from "./exec.mjs";
import { normalize } from "./paths.mjs";

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";

/** Strip a leading /dev/ so "/dev/ttys014" and "ttys014" compare equal. */
function shortTty(tty) {
  return String(tty || "").replace(/^\/dev\//, "");
}

/**
 * @param {string[]} ttys e.g. ["/dev/ttys014", "ttys011"]
 * @returns {Promise<Map<string,{cwd:string, proc:string|null}>>} short-tty -> {cwd, process label}
 */
export async function resolveCwds(ttys) {
  const wanted = new Set(ttys.map(shortTty).filter(Boolean));
  const result = new Map();
  if (wanted.size === 0) return result;

  // 1) One ps snapshot: pid, foreground-pgid, tty, and full command.
  const { stdout: psOut } = await run(PS, ["-A", "-o", "pid=,tpgid=,tty=,command="]);
  /** @type {Map<string, {fg: number|null, all: number[]}>} */
  const byTty = new Map();
  /** @type {Map<number, string>} */
  const pidCmd = new Map();
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const tpgid = Number(m[2]);
    const tty = m[3];
    const command = m[4];
    if (tty === "??" || tty === "?" || !wanted.has(tty)) continue;
    let e = byTty.get(tty);
    if (!e) byTty.set(tty, (e = { fg: null, all: [] }));
    e.all.push(pid);
    pidCmd.set(pid, command);
    // The foreground process group leader has pid == tpgid.
    if (pid === tpgid) e.fg = pid;
  }

  // 2) Collect candidate pids: foreground first, plus the shell (first/lowest
  //    pid on the tty) as a fallback for tabs whose fg pid has no readable cwd.
  const pidSet = new Set();
  for (const [, e] of byTty) {
    if (e.fg != null) pidSet.add(e.fg);
    const shell = Math.min(...e.all);
    if (Number.isFinite(shell)) pidSet.add(shell);
  }
  if (pidSet.size === 0) return result;

  // 3) One lsof for every candidate pid -> its cwd.
  const pidCwd = await lsofCwds([...pidSet]);

  // 4) Map each wanted tty to fg-cwd (fallback shell cwd), and label the tab by
  //    the foreground process (what's actually running in it).
  for (const tty of wanted) {
    const e = byTty.get(tty);
    if (!e) continue;
    const shell = Number.isFinite(Math.min(...e.all)) ? Math.min(...e.all) : null;
    const raw = (e.fg != null && pidCwd.get(e.fg)) || (shell != null && pidCwd.get(shell));
    if (!raw) continue;
    const labelPid = e.fg != null ? e.fg : shell;
    const proc = labelPid != null ? procLabel(pidCmd.get(labelPid)) : null;
    result.set(tty, { cwd: normalize(raw), proc });
  }
  return result;
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
 * @param {number[]} pids
 * @returns {Promise<Map<number,string>>} pid -> cwd path
 */
async function lsofCwds(pids) {
  const map = new Map();
  if (pids.length === 0) return map;
  // -a AND -d cwd (only the cwd descriptor) -p <csv>  -F pn (pid + name fields).
  const { stdout } = await run(LSOF, ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
  let cur = null;
  for (const line of stdout.split("\n")) {
    if (line[0] === "p") cur = Number(line.slice(1));
    else if (line[0] === "n" && cur != null) map.set(cur, line.slice(1));
  }
  return map;
}
