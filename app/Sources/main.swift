import AppKit

// Headless self-test: verifies the engine wiring without any UI.
//   TerminalSessions.app/Contents/MacOS/TerminalSessions --selftest
if CommandLine.arguments.contains("--selftest") {
    let folders = Engine.list()
    print("selftest: engine=\(Engine.enginePath)")
    print("selftest: node=\(Engine.nodePath ?? "NOT FOUND")")
    print("selftest: \(folders.count) folder(s)")
    for f in folders.prefix(12) {
        let detail = f.isOpen ? f.tabs.map { $0.proc }.joined(separator: ", ") : "recent"
        print("  \(f.name)  —  \(f.display)  [\(detail)]")
    }
    exit(folders.isEmpty ? 2 : 0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
