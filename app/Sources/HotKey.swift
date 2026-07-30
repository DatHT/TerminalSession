import AppKit
import Carbon.HIToolbox

// A single system-wide hot key via the Carbon Hot Key API. This deliberately
// avoids CGEventTap, so it needs NO Accessibility / Input-Monitoring permission.
// `registered` reports whether the combo was actually claimed (it may already be
// taken by another app), so the caller can fall back or warn instead of failing
// silently.

final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    let onFire: () -> Void
    private(set) var registered = false

    init(keyCode: UInt32, modifiers: UInt32, onFire: @escaping () -> Void) {
        self.onFire = onFire

        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, _, userData) -> OSStatus in
                guard let userData = userData else { return noErr }
                Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue().onFire()
                return noErr
            },
            1, &spec, selfPtr, &handler
        )

        let id = EventHotKeyID(signature: fourCharCode("TSmg"), id: 1)
        let regStatus = RegisterEventHotKey(
            keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref
        )

        registered = (installStatus == noErr && regStatus == noErr && ref != nil)
        if !registered {
            NSLog("[TerminalSessions] hot key not registered (install=\(installStatus), register=\(regStatus)) — combo likely already in use")
        }
    }

    deinit {
        if let ref = ref { UnregisterEventHotKey(ref) }
        if let handler = handler { RemoveEventHandler(handler) }
    }
}

private func fourCharCode(_ s: String) -> OSType {
    var result: OSType = 0
    for scalar in s.unicodeScalars.prefix(4) {
        result = (result << 8) + OSType(scalar.value & 0xFF)
    }
    return result
}
