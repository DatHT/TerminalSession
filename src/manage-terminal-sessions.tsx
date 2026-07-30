import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
  popToRoot,
  environment,
  getPreferenceValues,
  open,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useState } from "react";
import path from "node:path";

const execFileP = promisify(execFile);

// The engine is shipped as a plain-JS asset and run by Raycast's own Node
// runtime (process.execPath), so there are no PATH or module-resolution issues.
const ENGINE = path.join(environment.assetsPath, "tm", "cli.mjs");

type App = "iTerm2" | "Terminal";
interface Tab {
  app: App;
  tabId: string;
  tty: string;
  selected: boolean;
  frontmost: boolean;
  cwd: string | null;
}
interface Group {
  path: string;
  name: string;
  display: string;
  tabs: Tab[];
  apps: App[];
  frontmost: boolean;
  lastUsed: number;
}
interface Recent {
  path: string;
  name: string;
  display: string;
}
interface EngineError {
  app: string;
  message: string;
  needsAutomationPermission: boolean;
}
interface ListData {
  groups: Group[];
  recent: Recent[];
  errors: EngineError[];
}
interface Prefs {
  defaultApp: "auto" | "iTerm2" | "Terminal";
}

async function engine(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [ENGINE, ...args], {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "error", code: err.code ?? 1 };
  }
}

async function loadData(): Promise<ListData> {
  const { stdout, stderr, code } = await engine(["list", "--json"]);
  if (!stdout) throw new Error(stderr || `engine exited ${code}`);
  return JSON.parse(stdout) as ListData;
}

function appArgs(): string[] {
  const { defaultApp } = getPreferenceValues<Prefs>();
  if (defaultApp === "iTerm2") return ["--app", "iterm"];
  if (defaultApp === "Terminal") return ["--app", "terminal"];
  return [];
}

/** Run an engine action, then dismiss Raycast (the terminal takes over). */
async function act(args: string[], failTitle: string) {
  const { code, stderr } = await engine(args);
  if (code === 0) {
    await closeMainWindow();
    await popToRoot();
  } else {
    await showToast({ style: Toast.Style.Failure, title: failTitle, message: stderr.slice(0, 240) });
  }
}

function appColor(app: App): Color {
  return app === "iTerm2" ? Color.Orange : Color.Blue;
}

export default function Command() {
  const { isLoading, data, revalidate } = usePromise(loadData);
  const [search, setSearch] = useState("");

  const permissionError = data?.errors.find((e) => e.needsAutomationPermission);
  const looksLikePath = /^(~|\/|\.\/)/.test(search.trim());

  const refresh = (
    <Action
      title="Refresh List"
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={revalidate}
    />
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search folders with an open terminal…"
      onSearchTextChange={setSearch}
    >
      {permissionError ? (
        <List.EmptyView
          icon={{ source: Icon.Lock, tintColor: Color.Orange }}
          title="Automation permission needed"
          description="Allow Raycast to control Terminal.app and iTerm2, then refresh."
          actions={
            <ActionPanel>
              <Action
                title="Open Automation Settings"
                icon={Icon.Gear}
                onAction={() =>
                  open("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
                }
              />
              {refresh}
            </ActionPanel>
          }
        />
      ) : null}

      {/* Type a path that isn't open yet → offer to open it. */}
      {looksLikePath ? (
        <List.Section title="Open a folder by path">
          <List.Item
            icon={{ source: Icon.Plus, tintColor: Color.Blue }}
            title={`Open or focus: ${search.trim()}`}
            subtitle="reuses an existing terminal if that folder already has one"
            keywords={[search.trim()]}
            actions={
              <ActionPanel>
                <Action
                  title="Open or Focus"
                  icon={Icon.Terminal}
                  onAction={() => act(["open", search.trim(), ...appArgs()], "Could not open")}
                />
                {refresh}
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}

      <List.Section title="Open now" subtitle={data ? `${data.groups.length}` : undefined}>
        {(data?.groups ?? []).map((g) => {
          const accessories: List.Item.Accessory[] = [];
          if (g.tabs.length > 1)
            accessories.push({ tag: { value: `${g.tabs.length} tabs`, color: Color.Green } });
          for (const app of g.apps) accessories.push({ tag: { value: app, color: appColor(app) } });

          return (
            <List.Item
              key={g.path}
              icon={{ source: Icon.Terminal, tintColor: g.frontmost ? Color.Orange : Color.SecondaryText }}
              title={g.name}
              subtitle={g.display}
              keywords={[g.display, g.path]}
              accessories={accessories}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Focus Terminal"
                      icon={Icon.Eye}
                      onAction={() => act(["focus", g.tabs[0].tabId], "Could not focus (tab closed?)")}
                    />
                    {g.tabs.length > 1 ? (
                      <ActionPanel.Submenu title="Focus a Specific Tab" icon={Icon.List}>
                        {g.tabs.map((t) => (
                          <Action
                            key={t.tabId}
                            title={`${t.app} · ${t.tty}${t.frontmost ? " (front)" : ""}`}
                            onAction={() => act(["focus", t.tabId], "Could not focus")}
                          />
                        ))}
                      </ActionPanel.Submenu>
                    ) : null}
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action
                      title="Open Additional Window Here"
                      icon={Icon.PlusSquare}
                      shortcut={{ modifiers: ["cmd"], key: "return" }}
                      onAction={() => act(["open", g.path, "--new", ...appArgs()], "Could not open")}
                    />
                    <Action
                      title="Open New in iTerm2"
                      icon={Icon.Window}
                      onAction={() => act(["open", g.path, "--new", "--app", "iterm"], "Could not open")}
                    />
                    <Action
                      title="Open New in Terminal"
                      icon={Icon.Window}
                      onAction={() => act(["open", g.path, "--new", "--app", "terminal"], "Could not open")}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action.CopyToClipboard
                      title="Copy Path"
                      content={g.path}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                    <Action.ShowInFinder path={g.path} />
                    {refresh}
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>

      <List.Section title="Recent (no terminal open)">
        {(data?.recent ?? []).map((r) => (
          <List.Item
            key={r.path}
            icon={{ source: Icon.Folder, tintColor: Color.SecondaryText }}
            title={r.name}
            subtitle={r.display}
            keywords={[r.display, r.path]}
            actions={
              <ActionPanel>
                <Action
                  title="Open New Terminal Here"
                  icon={Icon.Terminal}
                  onAction={() => act(["open", r.path, ...appArgs()], "Could not open")}
                />
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={r.path}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action.ShowInFinder path={r.path} />
                {refresh}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      {!isLoading && !permissionError && (data?.groups.length ?? 0) === 0 && !looksLikePath ? (
        <List.EmptyView
          icon={{ source: Icon.Terminal, tintColor: Color.SecondaryText }}
          title="No terminals open"
          description="Type a folder path (starting with ~ or /) to open a new terminal there."
          actions={<ActionPanel>{refresh}</ActionPanel>}
        />
      ) : null}
    </List>
  );
}
