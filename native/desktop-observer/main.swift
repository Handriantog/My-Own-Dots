import AppKit
import ApplicationServices
import CoreGraphics

// Geometry-only adapter. Never reads AX titles, text, screenshots, or document data.
final class DesktopObserver {
    let session = UUID().uuidString
    var sequence = 0
    var revision = 0
    var generation = 0
    var identities: [String: Int] = [:]
    var observers: [pid_t: AXObserver] = [:]
    var watchedWindows: [pid_t: [AXUIElement]] = [:]
    var lastObservation = 0.0
    var activeUntil = 0.0
    var requestedActive = true
    var dirty = true
    var capture = false
    var lastTrusted = false
    var nextObserverRefresh = 0.0
    var inputBuffer = Data()
    let excluded: Set<pid_t>
    var clock: Double { ProcessInfo.processInfo.systemUptime * 1000 }
    var cadence: Double { requestedActive || clock < activeUntil ? 100 : 500 }

    init() {
        var pids = Set<pid_t>([getpid(), getppid()])
        let args = CommandLine.arguments
        for i in args.indices where args[i] == "--exclude-pid" && i + 1 < args.count {
            if let pid = Int32(args[i + 1]) { pids.insert(pid) }
        }
        excluded = pids
    }
    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    func rect(_ r: CGRect) -> [String: Double] { ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height] }
    func invalidate() { dirty = true; activeUntil = clock + 2000 }
    func sceneChanged() { revision += 1; invalidate(); snapshot(valid: false) }
    func refreshObservers() {
        let trusted = AXIsProcessTrusted()
        if trusted != lastTrusted { revision += 1; dirty = true; lastTrusted = trusted }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !excluded.contains($0.processIdentifier) }
        let alive = Set(apps.map { $0.processIdentifier })
        for pid in Array(observers.keys) where !alive.contains(pid) || !trusted {
            if let observer = observers.removeValue(forKey: pid) {
                CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            }
            watchedWindows.removeValue(forKey: pid)
        }
        guard trusted else { return }
        let context = Unmanaged.passUnretained(self).toOpaque()
        for app in apps {
            let pid = app.processIdentifier
            if observers[pid] == nil {
                var created: AXObserver?
                let result = AXObserverCreate(pid, { _, _, _, context in
                    guard let context = context else { return }
                    Unmanaged<DesktopObserver>.fromOpaque(context).takeUnretainedValue().invalidate()
                }, &created)
                guard result == .success, let created = created else { continue }
                observers[pid] = created
                CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
                let element = AXUIElementCreateApplication(pid)
                for name in [kAXWindowCreatedNotification, kAXFocusedWindowChangedNotification, kAXApplicationActivatedNotification] {
                    AXObserverAddNotification(created, element, name as CFString, context)
                }
            }
            guard let observer = observers[pid] else { continue }
            var value: CFTypeRef?
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.05)
            guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
                  let windows = value as? [AXUIElement] else { continue }
            let old = watchedWindows[pid] ?? []
            let notifications = [kAXMovedNotification, kAXResizedNotification, kAXUIElementDestroyedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification]
            for window in old where !windows.contains(where: { CFEqual($0, window) }) {
                for name in notifications { AXObserverRemoveNotification(observer, window, name as CFString) }
            }
            for window in windows where !old.contains(where: { CFEqual($0, window) }) {
                for name in notifications { AXObserverAddNotification(observer, window, name as CFString, context) }
            }
            watchedWindows[pid] = windows
        }
    }
    func snapshot(valid: Bool = true) {
        let now = clock
        let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
        let displays: [[String: Any]] = NSScreen.screens.compactMap { screen in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            let frame = screen.frame, work = screen.visibleFrame
            return ["id": id.stringValue, "bounds": rect(CGRect(x: frame.minX, y: mainHeight - frame.maxY, width: frame.width, height: frame.height)),
                    "workArea": rect(CGRect(x: work.minX, y: mainHeight - work.maxY, width: work.width, height: work.height)), "scaleFactor": screen.backingScaleFactor]
        }
        let all = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var alive = Set<String>()
        for info in all {
            guard let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int else { continue }
            let key = "\(pid):\(id)"; alive.insert(key)
            if identities[key] == nil { generation += 1; identities[key] = generation }
        }
        identities = identities.filter { alive.contains($0.key) }
        let regular = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { Int($0.processIdentifier) })
        let visible = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var windows: [[String: Any]] = []
        for info in visible {
            guard let id = info[kCGWindowNumber as String] as? Int,
                  let pid = info[kCGWindowOwnerPID as String] as? Int, !excluded.contains(pid_t(pid)), regular.contains(pid),
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let raw = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds.width >= 120, bounds.height >= 80,
                  let alpha = info[kCGWindowAlpha as String] as? Double, alpha > 0.01,
                  let gen = identities["\(pid):\(id)"] else { continue }
            windows.append(["id": id, "ownerPid": pid, "generation": gen, "bounds": rect(bounds), "opaque": alpha >= 0.97])
        }
        sequence += 1
        emit(["protocolVersion": 1, "helperSession": session, "seq": sequence, "observedAtMs": now,
              "sceneRevision": revision, "pollIntervalMs": cadence, "accessibility": AXIsProcessTrusted(),
              "sceneValid": valid && !displays.isEmpty, "displays": displays, "windows": Array(windows.prefix(2048))])
        lastObservation = now; dirty = !valid
    }
    func pointer() {
        guard capture, let position = CGEvent(source: nil)?.location else { return }
        emit(["kind": "pointer", "helperSession": session, "point": ["x": position.x, "y": position.y],
              "down": CGEventSource.buttonState(.combinedSessionState, button: .left), "observedAtMs": clock])
    }
    func command(_ value: String) {
        switch value {
        case "active": requestedActive = true
        case "idle": requestedActive = false
        case "refresh": invalidate()
        case "capture": capture = true
        case "release": capture = false
        default: break
        }
    }
    func run() {
        refreshObservers(); snapshot()
        if CommandLine.arguments.contains("--once") { return }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.sceneChanged() }
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.invalidate(); self?.nextObserverRefresh = 0 }
        }
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { exit(0) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.inputBuffer.append(data)
                if self.inputBuffer.count > 4096 { self.inputBuffer.removeAll() }
                while let index = self.inputBuffer.firstIndex(of: 10) {
                    let line = self.inputBuffer.prefix(upTo: index)
                    self.inputBuffer.removeSubrange(...index)
                    if let text = String(data: line, encoding: .utf8) { self.command(text) }
                }
            }
        }
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let now = self.clock
            self.pointer()
            if now >= self.nextObserverRefresh { self.refreshObservers(); self.nextObserverRefresh = now + 2000 }
            if (self.dirty && now - self.lastObservation >= 34) || now - self.lastObservation >= self.cadence { self.dirty = false; self.snapshot() }
        }
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
    }
}

let observer = DesktopObserver()
observer.run()
