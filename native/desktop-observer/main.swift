import AppKit
import ApplicationServices
import CoreGraphics

struct NativePointerSample {
    let point: CGPoint
    let down: Bool
    let revision: Double
    let sampledAtMs: Double
    let idleMs: Double
    var json: [String: Any] { ["point":["x":point.x,"y":point.y],"down":down,"revision":revision,"sampledAtMs":sampledAtMs,"idleMs":idleMs] }
}

// All side effects are injected; offline probes use fake input, bounds and warp.
final class ActivityPointerSession {
    let session: String
    let sample: () -> NativePointerSample
    let allowed: () -> Bool
    let bounds: () -> [CGRect]
    let warp: (CGPoint) -> Bool
    private(set) var active: Int?
    private var retired = 0
    private var pendingMove: String?
    init(session: String, sample: @escaping () -> NativePointerSample, allowed: @escaping () -> Bool, bounds: @escaping () -> [CGRect], warp: @escaping (CGPoint) -> Bool) {
        self.session=session; self.sample=sample; self.allowed=allowed; self.bounds=bounds; self.warp=warp
    }
    func invalidate() { if let active = active { retired=max(retired,active) }; active=nil }
    private func number(_ value: Any?) -> Double? {
        guard let n=value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    // Receiving a command never executes movement. Retirement can cancel work
    // buffered earlier in the same input batch before the next execution tick.
    func submit(_ text: String) -> [[String: Any]] {
        guard text.utf8.count <= 2048, let data=text.data(using:.utf8),
              let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { return [] }
        if value["op"] as? String == "move" {
            let previous=pendingMove
            pendingMove=text
            return previous.flatMap { command($0, allowWarp:false) }.map { [$0] } ?? []
        }
        guard let reply=command(text) else { return [] }
        if value["op"] as? String == "end", reply["ok"] as? Bool == true,
           let pending=pendingMove {
            // Leave a replacement generation queued; retiring an older start
            // must not cancel newer activity.
            let pendingData=pending.data(using:.utf8)!
            let queued=(try? JSONSerialization.jsonObject(with:pendingData)) as? [String:Any]
            if let generation=number(queued?["generation"]), generation <= Double(retired) {
                pendingMove=nil
                return (command(pending, allowWarp:false).map { [$0] } ?? []) + [reply]
            }
        }
        return [reply]
    }
    func flush() -> [[String: Any]] {
        guard let pending=pendingMove else { return [] }
        pendingMove=nil
        return command(pending).map { [$0] } ?? []
    }
    func command(_ text: String, allowWarp: Bool = true) -> [String: Any]? {
        guard text.utf8.count<=2048, let data=text.data(using:.utf8),
              let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              value["kind"] as? String == "activity", value["helperSession"] as? String == session,
              let op=value["op"] as? String, ["begin","move","end"].contains(op),
              let gen=number(value["generation"]), gen>=1, gen<=9007199254740991, gen.rounded()==gen,
              let request=number(value["requestId"]), request>=1, request<=9007199254740991, request.rounded()==request else { return nil }
        let keys: Set<String> = ["kind","helperSession","op","generation","requestId"]
        guard Set(value.keys)==(op=="move" ? keys.union(["x","y","revision","sampledAtMs"]) : keys) else { return nil }
        let generation=Int(gen)
        var reply: [String:Any] = ["kind":"activity-ack","helperSession":session,"generation":generation,"requestId":request,"ok":false]
        if op=="end" {
            retired=max(retired,generation)
            if let current=active, current<=generation { active=nil }
            reply["ok"]=true; return reply
        }
        guard allowed() else { invalidate(); return reply }
        if op=="begin" {
            guard generation>retired, active == nil || generation>active! else { return reply }
            if let current=active { retired=max(retired,current) }
            active=generation; reply["ok"]=true; reply["physical"]=sample().json; return reply
        }
        guard active==generation, generation>retired,
              let x=number(value["x"]), let y=number(value["y"]), abs(x)<100000, abs(y)<100000,
              let revision=number(value["revision"]), revision>=0, revision.rounded()==revision,
              let sampledAt=number(value["sampledAtMs"]), sampledAt>=0 else { return reply }
        let target=CGPoint(x:x,y:y)
        guard bounds().contains(where: { target.x >= $0.minX && target.y >= $0.minY && target.x < $0.maxX && target.y < $0.maxY }) else { return reply }
        // Re-read physical HID state immediately before warping, never trust a JS-only check.
        let physical=sample()
        guard !physical.down, physical.revision==revision,
              physical.sampledAtMs>=sampledAt, physical.sampledAtMs-sampledAt<=200 else { return reply }
        guard allowWarp else { return reply }
        reply["ok"]=warp(target)
        return reply
    }
}

// Slow cross-process observations never block pointer commands or CG scene heartbeats.
// Admission and completion are main-thread-only; a single serial job owns AX state.
final class AsyncObservation<Value> {
    private let queue = DispatchQueue(label: "dots.accessibility-observation", qos: .utility)
    private(set) var busy = false
    @discardableResult
    func request(_ read: @escaping () -> Value, completion: @escaping (Value) -> Void) -> Bool {
        precondition(Thread.isMainThread)
        guard !busy else { return false }
        busy = true
        queue.async {
            let value = read()
            DispatchQueue.main.async {
                self.busy = false
                completion(value)
            }
        }
        return true
    }
}
struct AccessibilityScreen: Equatable {
    let id: String
    let bounds: CGRect
}
struct DockObservation {
    let surfaces: [[String: Any]]
    let observedAtMs: Double
    let screens: [AccessibilityScreen]
    let revision: Int
    func current(now: Double, screens: [AccessibilityScreen], revision: Int) -> [[String: Any]] {
        guard now >= observedAtMs, now - observedAtMs <= 500,
              self.screens == screens, self.revision == revision else { return [] }
        return surfaces
    }
}
// Only the observation queue accesses these dictionaries or calls AX APIs.
// Notification run-loop sources invoke the immutable callback on the main thread.
final class AccessibilityObserverWorker {
    let onChange: () -> Void
    private var observers: [pid_t: AXObserver] = [:]
    private var watchedWindows: [pid_t: [AXUIElement]] = [:]
    var clock: Double { ProcessInfo.processInfo.systemUptime * 1000 }
    init(onChange: @escaping () -> Void) { self.onChange = onChange }
    func rect(_ r: CGRect) -> [String: Double] { ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height] }
    func read(pids: [pid_t], trusted: Bool, refresh: Bool, dockPid: pid_t?, screens: [AccessibilityScreen], revision: Int) -> DockObservation {
        // Configure the process default before the first notification subscription,
        // including child AX elements whose timeout has not been set explicitly.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.02)
        if refresh { refreshObservers(pids: pids, trusted: trusted) }
        let observedAt = clock
        let surfaces = trusted ? dockSurfaces(dockPid: dockPid, screens: screens) : []
        return DockObservation(surfaces: surfaces, observedAtMs: observedAt, screens: screens, revision: revision)
    }
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
    func dockSurfaces(dockPid: pid_t?, screens: [AccessibilityScreen]) -> [[String: Any]] {
        // Dock's on-screen CG window can cover an entire display. Never turn that
        // backing container, or NSScreen.visibleFrame's full-width inset, into a perch.
        guard AXIsProcessTrusted(), let dockPid = dockPid else { return [] }
        let application = AXUIElementCreateApplication(dockPid)
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
                      let hit = hit, AXUIElementGetPid(hit, &hitPid) == .success, hitPid == dockPid else { continue }
                for screen in screens {
                    if dockFits(bounds, screen.bounds) {
                        surfaces.append(["id": "ax:\(dockPid):\(identity)", "displayId": screen.id, "bounds": rect(bounds)])
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
    func refreshObservers(pids: [pid_t], trusted: Bool) {
        let alive = Set(pids)
        for pid in Array(observers.keys) where !alive.contains(pid) || !trusted {
            if let observer = observers.removeValue(forKey: pid) {
                DispatchQueue.main.async { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
            }
            watchedWindows.removeValue(forKey: pid)
        }
        guard trusted else { return }
        let context = Unmanaged.passUnretained(self).toOpaque()
        for pid in pids {
            if observers[pid] == nil {
                var created: AXObserver?
                let result = AXObserverCreate(pid, { _, _, _, context in
                    guard let context = context else { return }
                    Unmanaged<AccessibilityObserverWorker>.fromOpaque(context).takeUnretainedValue().onChange()
                }, &created)
                guard result == .success, let created = created else { continue }
                observers[pid] = created
                DispatchQueue.main.async { CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes) }
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
}

// Geometry-only adapter. Never reads AX titles, text, screenshots, or document data.
final class DesktopObserver {
    let session = UUID().uuidString
    var sequence = 0
    var revision = 0
    var generation = 0
    var identities: [String: Int] = [:]
    let accessibilityWork = AsyncObservation<DockObservation>()
    lazy var accessibilityObserver = AccessibilityObserverWorker(onChange: { [weak self] in self?.invalidate() })
    var dockObservation: DockObservation?
    var nextAccessibilityPoll = 0.0
    var lastObservation = 0.0
    var activeUntil = 0.0
    var requestedActive = true
    var dirty = true
    var capture = false
    var lastTrusted = false
    var nextObserverRefresh = 0.0
    var inputBuffer = Data()
    lazy var activityPointer = ActivityPointerSession(session: session, sample: { [unowned self] in self.physicalPointer() }, allowed: { AXIsProcessTrusted() }, bounds: {
        NSScreen.screens.compactMap { screen in
            guard let id=screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return CGDisplayBounds(CGDirectDisplayID(id.uint32Value))
        }
    }, warp: { CGWarpMouseCursorPosition($0) == .success })
    let physicalEvents: [CGEventType] = [.mouseMoved,.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.otherMouseDown,.otherMouseUp,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged,.scrollWheel]
    func physicalPointer() -> NativePointerSample {
        // Warps generate no events. HID counters distinguish manual input from our own motion.
        let revision=physicalEvents.reduce(0.0) { $0 + Double(CGEventSource.counterForEventType(.hidSystemState, eventType:$1)) }
        let idle=physicalEvents.map { CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:$0)*1000 }.min() ?? 0
        let down=(0..<32).contains { CGEventSource.buttonState(.combinedSessionState,button:CGMouseButton(rawValue:UInt32($0))!) }
        return NativePointerSample(point: CGEvent(source:nil)?.location ?? .zero,down:down,revision:revision,sampledAtMs:clock,idleMs:idle.isFinite ? max(0,idle) : 0)
    }
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
    func sceneChanged() { activityPointer.invalidate(); revision += 1; invalidate(); snapshot(valid: false) }
    func accessibilityScreens() -> [AccessibilityScreen] {
        NSScreen.screens.compactMap { screen in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return AccessibilityScreen(id: id.stringValue, bounds: CGDisplayBounds(CGDirectDisplayID(id.uint32Value)))
        }
    }
    func refreshObservers() {
        let trusted = AXIsProcessTrusted()
        if trusted != lastTrusted { revision += 1; dirty = true; lastTrusted = trusted; dockObservation = nil }
        guard !accessibilityWork.busy else { return }
        // AppKit access stays on main; the worker receives immutable values only.
        let pids = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !excluded.contains($0.processIdentifier) }.map { $0.processIdentifier }
        let dockPid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier
        let screens = accessibilityScreens(), revision = self.revision
        let refresh = clock >= nextObserverRefresh
        if refresh { nextObserverRefresh = clock + 2000 }
        let worker = accessibilityObserver
        accessibilityWork.request({ worker.read(pids: pids, trusted: trusted, refresh: refresh, dockPid: dockPid, screens: screens, revision: revision) }, completion: { [weak self] value in
            self?.dockObservation = value
            self?.dirty = true
        })
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
              "sceneValid": valid && !displays.isEmpty, "displays": displays, "windows": Array(windows.prefix(2048)), "docks": valid && AXIsProcessTrusted() ? (dockObservation?.current(now: now, screens: accessibilityScreens(), revision: revision) ?? []) : []])
        lastObservation = now; dirty = !valid
    }
    func pointer() {
        if let generation=activityPointer.active {
            emit(["kind":"activity-input","helperSession":session,"generation":generation,"physical":physicalPointer().json])
        }
        guard capture, let position = CGEvent(source: nil)?.location else { return }
        emit(["kind": "pointer", "helperSession": session, "point": ["x": position.x, "y": position.y],
              "down": CGEventSource.buttonState(.combinedSessionState, button: .left), "observedAtMs": clock])
    }
    func command(_ value: String) {
        if value.first == "{" { for reply in activityPointer.submit(value) { emit(reply) }; return }
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
            for reply in self.activityPointer.flush() { self.emit(reply) }
            // Refresh cached Dock geometry before its 500ms validity expires,
            // including when the ordinary scene heartbeat is idle at 500ms.
            if now >= self.nextAccessibilityPoll { self.refreshObservers(); self.nextAccessibilityPoll = now + min(self.cadence, 250) }
            if (self.dirty && now - self.lastObservation >= 34) || now - self.lastObservation >= self.cadence { self.dirty = false; self.snapshot() }
        }
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
    }
}

let observer = DesktopObserver()
observer.run()
