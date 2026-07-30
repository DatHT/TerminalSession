#!/usr/bin/env node
// Standalone CLI around the engine. Also the engine used by the Raycast UI.
//
//   node src/cli.mjs list            human-readable list of folders + tabs
//   node src/cli.mjs list --json     machine-readable (used by fzf, scripts)
//   node src/cli.mjs focus <tabId>   focus a specific tab
//   node src/cli.mjs open <folder>   reuse existing terminal, else open new
//        open <folder> --app iterm|terminal   force which app opens a new one
//   node src/cli.mjs doctor          diagnostics / permission check

import {
  listSessions,
  focusTab,
  scanTabs,
  openOrFocus,
  openFolder,
  doctor,
} from "./lib/engine.mjs";

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const pos = rest.filter((a) => !a.startsWith("--"));

function appFlag() {
  const i = rest.indexOf("--app");
  const v = i >= 0 ? rest[i + 1] : null;
  if (v === "iterm" || v === "iTerm2") return "iTerm2";
  if (v === "terminal" || v === "Terminal") return "Terminal";
  return undefined;
}

async function main() {
  switch (cmd) {
    case "list": {
      const data = await listSessions();
      if (flags.has("--json")) {
        console.log(JSON.stringify(data, null, 2));
        break;
      }
      if (flags.has("--paths")) {
        // One folder per line, open terminals first — ideal for piping to fzf.
        for (const g of data.groups) console.log(g.path);
        for (const r of data.recent) console.log(r.path);
        break;
      }
      if (data.errors.length) {
        for (const e of data.errors) console.error(`! ${e.app}: ${e.message}`);
      }
      if (!data.groups.length) {
        console.log("No terminals open (or none whose folder could be read).");
      }
      for (const g of data.groups) {
        const badge = g.apps.join("+") + (g.tabs.length > 1 ? ` ·${g.tabs.length} tabs` : "");
        const front = g.frontmost ? " *" : "";
        console.log(`${g.name}${front}\n    ${g.display}   [${badge}]`);
        for (const t of g.tabs) {
          console.log(`      - ${t.app}  ${t.proc || "?"}  ${t.tty}  ${t.tabId}`);
        }
      }
      if (data.recent.length) {
        console.log("\nRecent (no terminal open):");
        for (const r of data.recent) console.log(`  ${r.name}   ${r.display}`);
      }
      break;
    }

    case "focus": {
      const id = pos[0];
      if (!id) return fail("usage: focus <tabId>");
      const { tabs } = await scanTabs();
      const tab = tabs.find((t) => t.tabId === id);
      if (!tab) return fail(`no open tab with id ${id}`);
      const ok = await focusTab(tab);
      console.log(ok ? `focused ${tab.app} ${tab.tty}` : "could not focus (tab gone?)");
      break;
    }

    case "open": {
      const folder = pos[0];
      if (!folder) return fail("usage: open <folder> [--app iterm|terminal] [--new]");
      if (flags.has("--new")) {
        // Force a brand-new window even if a terminal for this folder exists.
        const res = await openFolder(folder, { app: appFlag() });
        console.log(`opened new ${res.app} window → ${res.path}`);
      } else {
        const res = await openOrFocus(folder, { app: appFlag() });
        if (res.action === "focused") console.log(`reused existing terminal → ${res.path}`);
        else console.log(`opened new ${res.app} window → ${res.path}`);
      }
      break;
    }

    case "doctor": {
      console.log(JSON.stringify(await doctor(), null, 2));
      break;
    }

    default:
      console.log(
        "commands: list [--json] | focus <tabId> | open <folder> [--app iterm|terminal] | doctor"
      );
  }
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e && e.needsAutomationPermission
    ? `Automation permission needed: ${e.message}\nGrant it in System Settings → Privacy & Security → Automation.`
    : String(e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
