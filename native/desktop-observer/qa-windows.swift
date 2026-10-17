// Disposable standalone AppKit windows for native companion QA, never bundled.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
var windows: [NSWindow] = []
let screen = NSScreen.main!.visibleFrame
for index in 0..<20 {
    let window = NSWindow(contentRect: NSRect(x: screen.minX + 70 + CGFloat(index % 5) * 220,
                                            y: screen.minY + 45 + CGFloat(index / 5) * 145,
                                            width: 360, height: 250),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = String(format: "Dot QA %02d", index + 1)
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.fullScreenPrimary]
    let label = NSTextField(labelWithString: "Disposable Dot playground test window")
    label.frame = NSRect(x: 20, y: 185, width: 320, height: 35)
    label.font = .systemFont(ofSize: 16, weight: .medium)
    let field = NSTextField(frame: NSRect(x: 20, y: 125, width: 315, height: 32))
    field.placeholderString = "Type here to check keyboard focus"
    field.setAccessibilityIdentifier("dot-qa-focus-field")
    let description = NSTextField(wrappingLabelWithString: "This window contains only temporary test data. Move, resize, minimize or enter fullscreen to test the desktop companion.")
    description.frame = NSRect(x: 20, y: 30, width: 315, height: 70)
    window.contentView?.addSubview(label); window.contentView?.addSubview(field); window.contentView?.addSubview(description)
    windows.append(window); window.orderFront(nil)
}
windows[0].makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
