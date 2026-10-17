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
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    func dockBounds(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &extent),
              [point.x, point.y, extent.width, extent.height].allSatisfy({ $0.isFinite }) else { return nil }
        return CGRect(origin: point, size: extent)
    }
    func dockFits(_ r: CGRect, _ d: CGRect) -> Bool {
        guard r.width >= 12, r.height >= 12, r.minX >= d.minX - 1, r.minY >= d.minY - 1,
              r.maxX <= d.maxX + 1, r.maxY <= d.maxY + 1 else { return false }
        if r.width >= r.height { return r.height < d.height / 2 && abs(r.maxY - d.maxY) <= 24 }
        return r.width < d.width / 2 && (abs(r.minX - d.minX) <= 24 || abs(r.maxX - d.maxX) <= 24)
    }
    func dockSurfaces() -> [[String: Any]] {
        // Dock's on-screen CG window can cover an entire display. Never turn that
        // backing container, or NSScreen.visibleFrame's full-width inset, into a perch.
        guard AXIsProcessTrusted(), let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return [] }
        let application = AXUIElementCreateApplication(dock.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.02)
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.02)
        var queue: [(AXUIElement, String, Int)] = [(application, "root", 0)]
        var surfaces: [[String: Any]] = []
        var visited = 0
        let deadline = clock + 75
        while !queue.isEmpty && visited < 32 && clock < deadline {
            let (element, identity, depth) = queue.removeFirst(); visited += 1
            if (attribute(element, kAXHiddenAttribute) as? Bool) == true { continue }
            if (attribute(element, kAXRoleAttribute) as? String) == kAXListRole,
               let bounds = dockBounds(element) {
                // A hit test confirms the list is currently exposed. Hidden Dock
                // geometry can linger in AX; it must disappear as physical support.
                var hit: AXUIElement?
                var hitPid: pid_t = 0
                guard AXUIElementCopyElementAtPosition(system, Float(bounds.midX), Float(bounds.midY), &hit) == .success,
                      let hit = hit, AXUIElementGetPid(hit, &hitPid) == .success, hitPid == dock.processIdentifier else { continue }
                for screen in NSScreen.screens {
                    guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
                    let displayBounds = CGDisplayBounds(CGDirectDisplayID(id.uint32Value))
                    if dockFits(bounds, displayBounds) {
                        surfaces.append(["id": "ax:\(dock.processIdentifier):\(identity)", "displayId": id.stringValue, "bounds": rect(bounds)])
                    }
                }
                continue
            }
            if depth < 2 {
                var children: CFArray?
                if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 16, &children) == .success,
                   let children = children as? [AXUIElement] {
                    for (index, child) in children.enumerated() { queue.append((child, "\(identity).\(index)", depth + 1)) }
                }
            }
        }
        return Array(surfaces.prefix(32))
    }
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
              "sceneValid": valid && !displays.isEmpty, "displays": displays, "windows": Array(windows.prefix(2048)), "docks": valid ? dockSurfaces() : []])
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
