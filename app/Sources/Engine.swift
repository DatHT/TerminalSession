import Foundation

// Talks to the same tested Node engine (assets/tm/cli.mjs), bundled into the
// app's Resources so the .app is self-contained. Node itself is the only
// external runtime (a CLI, not an app).

struct EngineTab: Decodable {
    let app: String
    let tabId: String
    let tty: String
    let proc: String?
}

struct EngineGroup: Decodable {
    let path: String
    let name: String
    let display: String
    let apps: [String]
    let tabs: [EngineTab]
    let frontmost: Bool
}

struct EngineRecent: Decodable {
    let path: String
    let name: String
    let display: String
}

struct EngineError: Decodable {
    let app: String
    let message: String
    let needsAutomationPermission: Bool
}

struct EngineList: Decodable {
    let groups: [EngineGroup]
    let recent: [EngineRecent]
    let errors: [EngineError]?   // partial-scan warnings; nil on older engines
}

// Outcome of a list refresh: the folder rows plus an optional status/warning
// line (a partial scan, a decode failure) so the UI never shows a silently
// short list.
struct ListResult {
    let rows: [FolderRow]
    let status: String?
}

// A specific open terminal within a folder.
struct TabRow {
    let tabId: String
    let proc: String   // "claude", "shell", "hermes", …
    let app: String    // "Terminal" / "iTerm2"
    let tty: String     // short, e.g. "ttys014"
}

// One folder in the top-level list. Open folders carry their terminals.
struct FolderRow {
    let name: String
    let display: String
    let path: String
    let isOpen: Bool
    let tabs: [TabRow]      // empty for a recent (closed) folder
    let searchText: String
}

enum Engine {

    private static var nodeResolved = false
    private static var nodeCache: String?

    /// Absolute path to a usable `node`, or nil if none can be found. GUI apps
    /// launched by launchd inherit a minimal PATH, so we can't rely on PATH:
    /// probe common locations (incl. nvm/fnm/volta/asdf), then, as a last
    /// resort, ask a login shell (which sources the user's profile). Cached.
    static var nodePath: String? {
        if !nodeResolved {
            nodeResolved = true
            nodeCache = computeNodePath()
        }
        return nodeCache
    }

    static var nodeAvailable: Bool { nodePath != nil }

    private static func computeNodePath() -> String? {
        let fm = FileManager.default
        let home = NSHomeDirectory()
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            home + "/.volta/bin/node",
            home + "/.asdf/shims/node",
        ]
        // nvm / fnm keep versioned dirs — add the newest of each if present.
        let versionRoots = [
            home + "/.nvm/versions/node",
            home + "/Library/Application Support/fnm/node-versions",
        ]
        for base in versionRoots {
            if let entries = try? fm.contentsOfDirectory(atPath: base) {
                for v in entries.sorted(by: >) {
                    candidates.append(base + "/" + v + "/bin/node")
                    candidates.append(base + "/" + v + "/installation/bin/node") // fnm layout
                }
            }
        }
        for c in candidates where fm.isExecutableFile(atPath: c) { return c }
        return loginShellNode()
    }

    /// Last resort: a login shell sources the user's profile, so nvm/fnm/etc.
    /// put node on PATH there even though the GUI app's own PATH is minimal.
    private static func loginShellNode() -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    static var enginePath: String {
        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("tm/cli.mjs").path,
            FileManager.default.fileExists(atPath: bundled) {
            return bundled
        }
        // Fallback to the source checkout (useful when run un-bundled).
        return NSHomeDirectory()
            + "/Documents/learning/claude/terminalManagement/assets/tm/cli.mjs"
    }

    /// Run the engine and return raw stdout Data (nil if node is unavailable,
    /// the process can't start, or it exceeds `timeout`). stderr is discarded to
    /// /dev/null so it can never fill a pipe buffer and block the stdout read.
    ///
    /// The read happens on a background thread bounded by `timeout` so a stuck
    /// scan — e.g. a process whose cwd sits on a dead network mount — can never
    /// hang the menu bar forever. In the normal case the read completes in well
    /// under a second, so nothing is truncated.
    @discardableResult
    static func run(_ args: [String], timeout: TimeInterval = 40) -> Data? {
        guard let node = nodePath else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [enginePath] + args
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return nil
        }

        let handle = out.fileHandleForReading
        let sem = DispatchSemaphore(value: 0)
        var data = Data()
        DispatchQueue.global(qos: .userInitiated).async {
            data = handle.readDataToEndOfFile()   // returns at EOF (incl. after terminate)
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()                       // SIGTERM the stuck child
            _ = sem.wait(timeout: .now() + 2)      // let the reader drain EOF
            return nil
        }
        proc.waitUntilExit()
        return data                                // safe: semaphore is a memory barrier
    }

    /// Fetch folders (those with an open terminal first, then recent), plus an
    /// optional status line for partial scans / read failures.
    static func list() -> ListResult {
        guard let data = run(["list", "--json"]) else {
            // nil ⇒ node missing or the scan timed out. The node-missing copy is
            // chosen by the caller; here we only flag a genuine timeout.
            return ListResult(rows: [], status: nodeAvailable
                ? "Couldn’t read your terminals in time. Try again."
                : nil)
        }
        guard let parsed = try? JSONDecoder().decode(EngineList.self, from: data) else {
            return ListResult(rows: [], status: "Couldn’t read the terminal list (incomplete response). Try again.")
        }

        var rows: [FolderRow] = []
        for g in parsed.groups {
            let tabs = g.tabs.map { t -> TabRow in
                let label = (t.proc?.isEmpty == false) ? t.proc! : t.app.lowercased()
                let tty = t.tty.replacingOccurrences(of: "/dev/", with: "")
                return TabRow(tabId: t.tabId, proc: label, app: t.app, tty: tty)
            }
            let procs = tabs.map { $0.proc }.joined(separator: " ")
            rows.append(FolderRow(
                name: g.name,
                display: g.display,
                path: g.path,
                isOpen: true,
                tabs: tabs,
                searchText: (g.name + " " + g.display + " " + procs).lowercased()
            ))
        }
        for r in parsed.recent {
            rows.append(FolderRow(
                name: r.name,
                display: r.display,
                path: r.path,
                isOpen: false,
                tabs: [],
                searchText: (r.name + " " + r.display).lowercased()
            ))
        }

        // Surface a partial-scan reason so a short list is never silent. A
        // permission denial often hits just ONE app (e.g. iTerm allowed,
        // Terminal not), hiding that app's tabs while others still return rows —
        // so it must show even when the list is non-empty.
        let errs = parsed.errors ?? []
        let status: String?
        if errs.contains(where: { $0.needsAutomationPermission }) {
            status = "Some terminals are hidden — grant Automation permission in "
                + "System Settings ▸ Privacy & Security ▸ Automation."
        } else {
            status = errs.first?.message
        }
        return ListResult(rows: rows, status: status)
    }

    /// Reuse the terminal in `path`, else open a new one there.
    static func open(_ path: String) {
        _ = run(["open", path])
    }

    /// Focus a specific tab by id.
    static func focus(_ tabId: String) {
        _ = run(["focus", tabId])
    }
}
