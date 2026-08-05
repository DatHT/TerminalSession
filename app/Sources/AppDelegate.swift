import AppKit
import Carbon.HIToolbox
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var panel: FloatingPanel!
    private let vc = SearchViewController()
    private var hotKey: HotKey?
    private var activeShortcut: String?
    /// Whether the panel was visible at the instant the status item's mouseDown
    /// landed. The mouseDown can hide the panel (key loss) before the action
    /// fires on mouseUp — deciding from this captured state instead of a
    /// wall-clock window makes the click a true toggle regardless of timing.
    private var panelWasVisibleAtStatusMouseDown: Bool?
    private var statusMouseMonitor: Any?
    /// The launch auto-show, cancellable so it never races a user-initiated
    /// show/hide (it would re-run reload and wipe typed text).
    private var autoShowItem: DispatchWorkItem?

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
        // A minimal main menu: invisible for an accessory app, but ⌘X/⌘C/⌘V/⌘A
        // in the search field resolve through it — without one they are dead.
        buildEditMenu()
    }

    private func buildEditMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    @objc private func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor) {
        // terminalsessions://show (default) · ://hide · ://toggle
        let url = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue ?? ""
        let command = URL(string: url)?.host ?? "show"
        DispatchQueue.main.async { [weak self] in
            switch command {
            case "hide": self?.hidePanel()
            case "toggle": self?.togglePanel()
            default: self?.showPanel()
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        buildPanel()
        setupHotKey()
        updateTooltip()

        // Opening the app should do something visible. It's a menu-bar agent
        // (no window by default), so show the search panel on launch — unless
        // the user beats it to the punch (hotkey/URL), in which case it's
        // cancelled so it can't re-run reload and wipe their typed text.
        let item = DispatchWorkItem { [weak self] in self?.showPanel() }
        autoShowItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
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
        // Capture whether the panel was visible when the click STARTED — by the
        // time the action fires on mouseUp, the mouseDown may already have
        // hidden it (key loss), which is indistinguishable from "was hidden".
        statusMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] event in
            if let self, let button = self.statusItem.button, event.window === button.window {
                self.panelWasVisibleAtStatusMouseDown = self.panel.isVisible
            }
            return event
        }
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
            // .nonactivatingPanel: the panel takes KEYBOARD focus without
            // activating the app — the Spotlight/Alfred pattern. macOS then
            // never has to switch Spaces or juggle app activation to show it,
            // which is what made it flaky/invisible over full-screen apps.
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
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
        // Appear on the CURRENT Space — including inside a full-screen app's own
        // Space — not just the Space where the panel was created.
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Dismissal is Spotlight-style via windowDidResignKey (click away / the
        // panel loses keyboard focus). hidesOnDeactivate must stay OFF: with it
        // on, the full-screen app re-asserting activation right after we showed
        // the panel would hide it within milliseconds — the "I press the hotkey
        // and nothing appears" bug.
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.delegate = self
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
        autoShowItem?.cancel()
        autoShowItem = nil
        if NSApp.isHidden { NSApp.unhide(nil) }
        vc.reload()
        positionPanel()
        // Deliberately NO NSApp.activate: a .nonactivatingPanel takes keyboard
        // focus on makeKey without activating the app, so the full-screen app
        // in front keeps its activation and macOS shows us on the current Space
        // immediately. orderFrontRegardless covers the app-inactive case.
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        DispatchQueue.main.async { [weak self] in self?.vc.focusSearchField() }
    }

    private func hidePanel() {
        guard panel.isVisible else { return }
        autoShowItem?.cancel()
        autoShowItem = nil
        panel.orderOut(nil)
        // If something activated us (URL open, Finder reopen), hand activation
        // back — otherwise the active app has zero windows and keystrokes go
        // nowhere until the user clicks. The hotkey path never activates us,
        // so this is a no-op there.
        if NSApp.isActive { NSApp.hide(nil) }
    }

    /// Spotlight-style dismissal: hide whenever the panel loses keyboard focus
    /// (the user clicked another window/app or switched away).
    func windowDidResignKey(_ notification: Notification) {
        guard (notification.object as? NSWindow) === panel else { return }
        hidePanel()
    }

    // Center horizontally, near the top third of whichever screen the mouse is on.
    private func positionPanel() {
        let mouse = NSEvent.mouseLocation
        // NSMouseInRect (flipped:false), not CGRect.contains: the cursor pinned
        // to a display's top edge reports y == frame.maxY, which `contains`
        // excludes — picking the wrong screen on multi-monitor setups.
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let vf = screen?.visibleFrame else { return }
        let size = panel.frame.size
        let x = vf.midX - size.width / 2
        // Clamp so short screens can't push the panel's bottom under the Dock.
        let y = max(vf.minY, vf.maxY - size.height - vf.height * 0.12)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    // MARK: - status item interaction

    @objc private func statusClicked() {
        let event = NSApp.currentEvent
        // Consume the state captured at mouseDown (see statusMouseMonitor).
        let wasVisibleAtMouseDown = panelWasVisibleAtStatusMouseDown ?? panel.isVisible
        panelWasVisibleAtStatusMouseDown = nil
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showMenu()
        } else if wasVisibleAtMouseDown {
            hidePanel()   // the click meant "close" (mouseDown may have already hidden it)
        } else {
            showPanel()
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
