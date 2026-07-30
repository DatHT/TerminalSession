import AppKit
import Carbon.HIToolbox
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: FloatingPanel!
    private let vc = SearchViewController()
    private var hotKey: HotKey?
    private var activeShortcut: String?

    // Candidate global hot keys, tried in order until one is free. None need
    // Accessibility permission (Carbon hot keys).
    private let shortcutCandidates: [(key: Int, mods: Int, label: String)] = [
        (kVK_Space, optionKey, "⌥Space"),
        (kVK_Space, optionKey | controlKey, "⌃⌥Space"),
        (kVK_ANSI_T, optionKey | cmdKey, "⌥⌘T"),
    ]

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Handle terminalsessions:// URLs → show the panel.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURL(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    @objc private func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor) {
        DispatchQueue.main.async { [weak self] in self?.showPanel() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        buildPanel()
        setupHotKey()
        updateTooltip()

        // Opening the app should do something visible. It's a menu-bar agent
        // (no window by default), so show the search panel on launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.showPanel()
        }
    }

    // Double-clicking the app in Finder/Spotlight while it's already running
    // "reopens" it — show the search panel instead of doing nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return true
    }

    // MARK: - setup

    private func setupHotKey() {
        for c in shortcutCandidates {
            let hk = HotKey(keyCode: UInt32(c.key), modifiers: UInt32(c.mods)) { [weak self] in
                DispatchQueue.main.async { self?.togglePanel() }
            }
            if hk.registered {
                hotKey = hk
                activeShortcut = c.label
                break
            }
        }
        if hotKey == nil {
            NSLog("[TerminalSessions] no global hot key available — use the menu-bar icon to open search.")
        }
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.image = makeMenuBarImage()
        button.target = self
        button.action = #selector(statusClicked)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    // The logo mark drawn as a monochrome template image, so it shows in the
    // menu bar and adapts to light/dark (unlike a full-colour icon or the
    // restricted "apple.terminal" SF Symbol, which can render blank).
    private func makeMenuBarImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 19, height: 16), flipped: false) { _ in
            NSColor.black.set()
            let chevron = NSBezierPath()
            chevron.lineWidth = 2.3
            chevron.lineCapStyle = .round
            chevron.lineJoinStyle = .round
            chevron.move(to: NSPoint(x: 3.5, y: 12.4))
            chevron.line(to: NSPoint(x: 8.6, y: 8))
            chevron.line(to: NSPoint(x: 3.5, y: 3.6))
            chevron.stroke()
            NSBezierPath(roundedRect: NSRect(x: 12, y: 3.4, width: 3.2, height: 9.2),
                         xRadius: 1.5, yRadius: 1.5).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    private func updateTooltip() {
        statusItem?.button?.toolTip = activeShortcut.map { "Terminal Sessions  (\($0))" }
            ?? "Terminal Sessions  (click to search)"
    }

    private func buildPanel() {
        let p = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 500),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        p.titlebarAppearsTransparent = true
        p.titleVisibility = .hidden
        p.standardWindowButton(.closeButton)?.isHidden = true
        p.standardWindowButton(.miniaturizeButton)?.isHidden = true
        p.standardWindowButton(.zoomButton)?.isHidden = true
        p.isMovableByWindowBackground = true
        p.level = .floating          // stays above normal windows (your terminals)
        p.hidesOnDeactivate = true   // Spotlight-like: closes when you switch away
        p.isReleasedWhenClosed = false
        p.contentViewController = vc
        vc.closePopover = { [weak self] in self?.hidePanel() }
        panel = p
    }

    // MARK: - show / hide

    private func togglePanel() {
        if panel.isVisible {
            hidePanel()
        } else {
            showPanel()
        }
    }

    private func showPanel() {
        guard panel != nil else { return }
        vc.reload()
        positionPanel()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        DispatchQueue.main.async { [weak self] in self?.vc.focusSearchField() }
    }

    private func hidePanel() {
        panel.orderOut(nil)
    }

    // Center horizontally, near the top third of whichever screen the mouse is on.
    private func positionPanel() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let vf = screen?.visibleFrame else { return }
        let size = panel.frame.size
        let x = vf.midX - size.width / 2
        let y = vf.maxY - size.height - vf.height * 0.12
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    // MARK: - status item interaction

    @objc private func statusClicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showMenu()
        } else {
            togglePanel()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Search Terminals…", action: #selector(searchAction), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Refresh", action: #selector(refreshAction), keyEquivalent: "r")

        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLoginAction), keyEquivalent: "")
        login.state = loginEnabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Terminal Sessions", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Show the menu on this click, then detach it so a left-click still opens search.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func searchAction() { showPanel() }

    @objc private func refreshAction() {
        if panel.isVisible { vc.reload() } else { showPanel() }
    }

    // MARK: - launch at login

    private var loginEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    @objc private func toggleLoginAction() {
        do {
            if loginEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn’t change the login setting"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
