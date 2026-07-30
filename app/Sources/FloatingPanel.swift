import AppKit

// A borderless-ish floating panel that can take keyboard focus (so the search
// field is typeable) and sits above other windows. Shown centered on screen —
// independent of the menu-bar icon, so it works even if that icon is hidden
// behind the notch or a crowded menu bar.
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
