import AppKit

// The search UI. Two levels:
//   • Folders  — one row per folder. A folder with >1 terminal shows
//                "N terminals ›"; press → or ↵ to drill in.
//   • Terminals — that folder's terminals, labelled by what's running
//                (claude / shell / …); ↵ focuses the chosen one, ← / esc goes back.
/// A table that never steals keyboard focus from the search field (Spotlight
/// pattern): clicks still select rows and fire the action, but typing, Enter,
/// Esc and the arrow keys keep flowing through the search field's editor.
private final class PassiveTableView: NSTableView {
    override var acceptsFirstResponder: Bool { false }
}

final class SearchViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate,
    NSSearchFieldDelegate {

    private enum Mode { case folders, terminals }

    private let searchField = NSSearchField()
    private let tableView: NSTableView = PassiveTableView()
    private let scrollView = NSScrollView()
    private let hint = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")

    private var mode: Mode = .folders
    private var allFolders: [FolderRow] = []
    private var folders: [FolderRow] = []       // filtered
    private var current: FolderRow?
    private var terminals: [TabRow] = []        // filtered tabs of `current`
    private var savedFolderQuery = ""
    private var loadWarning: String?            // partial-scan notice, shown in the footer
    private var reloadGeneration = 0            // drops stale async list results

    /// Set by the app: dismiss the panel.
    var closePopover: (() -> Void)?

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 500))
        preferredContentSize = container.frame.size

        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.delegate = self
        searchField.focusRingType = .none
        searchField.sendsWholeSearchString = false
        searchField.sendsSearchStringImmediately = true

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.headerView = nil
        tableView.rowHeight = 52
        tableView.backgroundColor = .clear
        tableView.selectionHighlightStyle = .regular
        tableView.intercellSpacing = NSSize(width: 0, height: 2)
        tableView.style = .inset
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("folder"))
        col.resizingMask = .autoresizingMask
        tableView.addTableColumn(col)
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        // A single click on a row jumps straight to that terminal (launcher-style),
        // and drills into a multi-terminal folder. Double-click works too.
        tableView.action = #selector(activateSelection)
        tableView.doubleAction = #selector(activateSelection)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.documentView = tableView

        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.font = .systemFont(ofSize: 10.5)
        hint.textColor = .tertiaryLabelColor

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .center
        statusLabel.isHidden = true

        container.addSubview(searchField)
        container.addSubview(scrollView)
        container.addSubview(hint)
        container.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalToConstant: 460),
            container.heightAnchor.constraint(equalToConstant: 500),

            searchField.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            searchField.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            searchField.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),

            scrollView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 6),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -6),
            scrollView.bottomAnchor.constraint(equalTo: hint.topAnchor, constant: -6),

            hint.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            hint.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            hint.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -8),

            statusLabel.centerXAnchor.constraint(equalTo: scrollView.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: scrollView.centerYAnchor),
        ])

        self.view = container
    }

    // Called each time the panel opens.
    func reload() {
        mode = .folders
        current = nil
        savedFolderQuery = ""
        searchField.placeholderString = "Search folders with a terminal…"
        searchField.stringValue = ""
        statusLabel.stringValue = "Loading…"
        statusLabel.isHidden = false
        allFolders = []
        folders = []
        tableView.reloadData()
        updateHint()

        reloadGeneration += 1
        let generation = reloadGeneration
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Engine.list()
            DispatchQueue.main.async {
                // A newer reload started while this one was scanning — drop it.
                guard generation == self.reloadGeneration else { return }
                self.allFolders = result.rows
                // A warning decorates the footer only when we DO have rows; when
                // the list is empty the reason goes in the centered status label.
                self.loadWarning = result.rows.isEmpty ? nil : result.status
                // Honor whatever the user has typed while the scan ran — filtering
                // with "" would discard their query and select the wrong row.
                self.applyFolderFilter(self.searchField.stringValue)
                self.statusLabel.isHidden = !result.rows.isEmpty
                if result.rows.isEmpty {
                    self.statusLabel.stringValue = !Engine.nodeAvailable
                        ? "Node.js not found.\nInstall Node so the tool can read your terminals."
                        : (result.status ?? "No open terminals.\nType a path (⏎) to open one.")
                }
                self.updateHint()
            }
        }
    }

    func focusSearchField() {
        view.window?.makeFirstResponder(searchField)
    }

    // MARK: - filtering

    private func applyFolderFilter(_ query: String) {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        folders = q.isEmpty ? allFolders : allFolders.filter { fuzzy(q, $0.searchText) }
        reloadAndSelectFirst()
    }

    private func applyTerminalFilter(_ query: String) {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        let all = current?.tabs ?? []
        terminals = q.isEmpty ? all : all.filter { fuzzy(q, ($0.proc + " " + $0.tty).lowercased()) }
        reloadAndSelectFirst()
    }

    private func reloadAndSelectFirst() {
        tableView.reloadData()
        let count = (mode == .folders) ? folders.count : terminals.count
        if count > 0 {
            tableView.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            tableView.scrollRowToVisible(0)
        }
    }

    /// Subsequence fuzzy match.
    private func fuzzy(_ q: String, _ text: String) -> Bool {
        if q.isEmpty { return true }
        var i = q.startIndex
        for ch in text where ch == q[i] {
            i = q.index(after: i)
            if i == q.endIndex { return true }
        }
        return false
    }

    // MARK: - typing & key commands

    func controlTextDidChange(_ obj: Notification) {
        if mode == .folders { applyFolderFilter(searchField.stringValue) }
        else { applyTerminalFilter(searchField.stringValue) }
    }

    func control(_ control: NSControl, textView: NSTextView,
                 doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.moveDown(_:)):
            moveSelection(by: 1); return true
        case #selector(NSResponder.moveUp(_:)):
            moveSelection(by: -1); return true
        case #selector(NSResponder.insertNewline(_:)):
            activatePrimary(); return true
        case #selector(NSResponder.moveRight(_:)):
            // → expands a multi-terminal folder, but only at the end of the text
            // (so it still moves the cursor while editing).
            if mode == .folders, cursorAtEnd(textView), let f = selectedFolder(), f.isOpen, f.tabs.count > 1 {
                enterTerminals(f); return true
            }
            return false
        case #selector(NSResponder.moveLeft(_:)):
            if mode == .terminals, cursorAtStart(textView) { backToFolders(); return true }
            return false
        case #selector(NSResponder.cancelOperation(_:)):
            if mode == .terminals { backToFolders() } else { closePopover?() }
            return true
        default:
            return false
        }
    }

    private func moveSelection(by delta: Int) {
        let count = (mode == .folders) ? folders.count : terminals.count
        guard count > 0 else { return }
        let next = min(max(0, tableView.selectedRow + delta), count - 1)
        tableView.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        tableView.scrollRowToVisible(next)
    }

    private func selectedFolder() -> FolderRow? {
        let r = tableView.selectedRow
        return (r >= 0 && r < folders.count) ? folders[r] : nil
    }

    @objc private func activateSelection() { activatePrimary() }

    private func activatePrimary() {
        if mode == .terminals {
            let r = tableView.selectedRow
            guard r >= 0 && r < terminals.count else { return }
            focusAndClose(terminals[r].tabId)
            return
        }
        // folders mode
        guard let f = selectedFolder() else {
            // Nothing selected but the user typed a path → open it.
            let typed = searchField.stringValue.trimmingCharacters(in: .whitespaces)
            if typed.hasPrefix("/") || typed.hasPrefix("~") { openAndClose(typed) }
            return
        }
        if !f.isOpen {
            openAndClose(f.path)                 // recent → open new
        } else if f.tabs.count > 1 {
            enterTerminals(f)                    // drill in to pick
        } else if let t = f.tabs.first {
            focusAndClose(t.tabId)               // single terminal → focus it
        } else {
            openAndClose(f.path)
        }
    }

    private func focusAndClose(_ tabId: String) {
        closePopover?()
        DispatchQueue.global(qos: .userInitiated).async { Engine.focus(tabId) }
    }

    private func openAndClose(_ path: String) {
        closePopover?()
        DispatchQueue.global(qos: .userInitiated).async { Engine.open(path) }
    }

    // MARK: - drill in / out

    private func enterTerminals(_ folder: FolderRow) {
        savedFolderQuery = searchField.stringValue
        current = folder
        mode = .terminals
        searchField.stringValue = ""
        searchField.placeholderString = "‹ \(folder.name) — pick a terminal"
        applyTerminalFilter("")
        updateHint()
        focusSearchField()   // a mouse drill-in must not leave the keyboard dead
    }

    private func backToFolders() {
        mode = .folders
        current = nil
        searchField.placeholderString = "Search folders with a terminal…"
        searchField.stringValue = savedFolderQuery
        applyFolderFilter(savedFolderQuery)
        updateHint()
        focusSearchField()
    }

    private func updateHint() {
        let base = (mode == .folders)
            ? "↑↓ move    ↵ open · ⟶ expand    esc close"
            : "↑↓ move    ↵ focus    ⟵ / esc back"
        if mode == .folders, let w = loadWarning {
            hint.stringValue = "⚠︎ " + w
            hint.textColor = .systemOrange
        } else {
            hint.stringValue = base
            hint.textColor = .tertiaryLabelColor
        }
    }

    private func cursorAtEnd(_ tv: NSTextView) -> Bool {
        let r = tv.selectedRange()
        return r.length == 0 && r.location == (tv.string as NSString).length
    }
    private func cursorAtStart(_ tv: NSTextView) -> Bool {
        let r = tv.selectedRange()
        return r.length == 0 && r.location == 0
    }

    // MARK: - table data

    func numberOfRows(in tableView: NSTableView) -> Int {
        mode == .folders ? folders.count : terminals.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?,
                   row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("FolderCell")
        let cell = (tableView.makeView(withIdentifier: id, owner: self) as? FolderCellView)
            ?? FolderCellView(id: id)

        if mode == .folders {
            let f = folders[row]
            let badge: String
            let accent: Bool
            if !f.isOpen {
                badge = "reopen"; accent = true
            } else if f.tabs.count > 1 {
                badge = "\(f.tabs.count) terminals ›"; accent = true
            } else {
                badge = f.tabs.first?.proc ?? ""; accent = false
            }
            cell.configure(title: f.name, subtitle: f.display, badge: badge, accent: accent)
        } else {
            let t = terminals[row]
            cell.configure(title: t.proc, subtitle: "\(t.app) · \(t.tty)", badge: "", accent: false)
        }
        return cell
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { true }
}

// A two-line row: bold title + optional badge, dim subtitle. Recolors when
// selected so text stays legible on the highlight.
final class FolderCellView: NSTableCellView {
    private let label = NSTextField(labelWithString: "")
    private var title = ""
    private var subtitle = ""
    private var badge = ""
    private var accent = false

    init(id: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        identifier = id
        label.translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 2
        label.cell?.usesSingleLineMode = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(title: String, subtitle: String, badge: String, accent: Bool) {
        self.title = title
        self.subtitle = subtitle
        self.badge = badge
        self.accent = accent
        render()
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { render() }
    }

    private func render() {
        let selected = backgroundStyle == .emphasized
        let primary: NSColor = selected ? .white : .labelColor
        let secondary: NSColor = selected ? NSColor.white.withAlphaComponent(0.85) : .secondaryLabelColor
        let badgeColor: NSColor = selected
            ? NSColor.white.withAlphaComponent(0.9)
            : (accent ? .controlAccentColor : .tertiaryLabelColor)

        let para = NSMutableParagraphStyle()
        para.lineSpacing = 2
        para.lineBreakMode = .byTruncatingTail

        let s = NSMutableAttributedString()
        s.append(NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: primary,
            .paragraphStyle: para,
        ]))
        if !badge.isEmpty {
            s.append(NSAttributedString(string: "   " + badge, attributes: [
                .font: NSFont.systemFont(ofSize: 10.5, weight: accent ? .medium : .regular),
                .foregroundColor: badgeColor,
                .paragraphStyle: para,
            ]))
        }
        if !subtitle.isEmpty {
            s.append(NSAttributedString(string: "\n" + subtitle, attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: secondary,
                .paragraphStyle: para,
            ]))
        }
        label.attributedStringValue = s
    }
}
