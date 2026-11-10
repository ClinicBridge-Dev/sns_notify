// AX bridge: the ONLY place Accessibility API calls happen.
//
// macOS does not pass this app's 손쉬운 사용 grant to the processes it spawns (verified: child
// gets kAXErrorAPIDisabled while the app is trusted). So the app performs every AX call itself and
// serves them to its own children over a private socketpair handed to each child as fd 0.
// No filesystem socket exists, so no other process can borrow the permission.
//
// Generic on purpose: no WhatsApp interpretation lives here (that is Python, which can change
// without rebuilding — every rebuild of this ad-hoc signed app resets the permission).
// Protocol: newline-delimited JSON.
//   request  {"id": 1, "op": "...", ...}
//   response {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "...", "code": -25211}
//   event    {"event": "AXValueChanged", "role": "...", "t": 12.3}   (after "subscribe")

import AppKit
import ApplicationServices

let TARGET_BUNDLE_ID = "net.whatsapp.WhatsApp"  // the bridge refuses to read any other app

struct BridgeError: Error {
    let message: String
    var code: Int32 = 0
}

final class BridgeConnection {
    let fd: Int32
    private let writeLock = NSLock()
    private weak var bridge: AXBridge?
    private(set) var closed = false

    init(fd: Int32, bridge: AXBridge) {
        self.fd = fd
        self.bridge = bridge
    }

    func start() {
        let t = Thread { [weak self] in self?.readLoop() }
        t.name = "ax-bridge-conn-\(fd)"
        t.start()
    }

    private func readLoop() {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if !line.isEmpty { bridge?.handle(line, from: self) }
            }
        }
        writeLock.lock(); closed = true; writeLock.unlock()
        close(fd)
        bridge?.remove(self)
    }

    func send(_ obj: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        if closed { return }
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = write(fd, raw.baseAddress!.advanced(by: off), raw.count - off)
                if w <= 0 { closed = true; return }
                off += w
            }
        }
    }
}

final class AXBridge {
    private let axQueue = DispatchQueue(label: "ax-bridge")  // serialize AX calls
    private var connections: [ObjectIdentifier: BridgeConnection] = [:]
    private var subscribers: [ObjectIdentifier: BridgeConnection] = [:]
    private let lock = NSLock()
    private var observer: AXObserver?
    private var observedPid: pid_t = 0
    private var registrations: [String: Int32] = [:]
    private let started = Date()

    static let defaultAttrs = ["AXRole", "AXSubrole", "AXRoleDescription", "AXIdentifier", "AXTitle", "AXDescription",
                               "AXValue", "AXHelp", "AXLabel", "AXPlaceholderValue", "AXSelected", "AXEnabled", "AXFocused"]
    static let notifications = ["AXValueChanged", "AXUIElementCreated", "AXUIElementDestroyed", "AXLayoutChanged",
                                "AXTitleChanged", "AXFocusedUIElementChanged", "AXSelectedChildrenChanged",
                                "AXRowCountChanged", "AXSelectedRowsChanged", "AXWindowCreated", "AXAnnouncementRequested"]

    // MARK: connections

    /// Start ``p`` with a private bridge on its fd 0.
    func launch(_ p: Process) throws {
        var fds: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { throw BridgeError(message: "socketpair_failed") }
        var on: Int32 = 1
        setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fds[0], F_SETFD, FD_CLOEXEC)  // later children must not inherit another child's bridge
        p.standardInput = FileHandle(fileDescriptor: fds[1], closeOnDealloc: false)
        var env = p.environment ?? ProcessInfo.processInfo.environment
        env["LW_AX_BRIDGE"] = "1"
        p.environment = env
        do {
            try p.run()
        } catch {
            close(fds[0]); close(fds[1])
            throw error
        }
        close(fds[1])  // only the child holds it now, so its exit gives us EOF
        let c = BridgeConnection(fd: fds[0], bridge: self)
        lock.lock(); connections[ObjectIdentifier(c)] = c; lock.unlock()
        c.start()
    }

    func remove(_ c: BridgeConnection) {
        lock.lock()
        connections.removeValue(forKey: ObjectIdentifier(c))
        subscribers.removeValue(forKey: ObjectIdentifier(c))
        lock.unlock()
    }

    // MARK: dispatch

    func handle(_ line: Data, from conn: BridgeConnection) {
        guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
            conn.send(["ok": false, "error": "bad_json"]); return
        }
        let id = req["id"] ?? NSNull()
        let op = req["op"] as? String ?? ""
        if op == "subscribe" {
            lock.lock(); subscribers[ObjectIdentifier(conn)] = conn; lock.unlock()
            DispatchQueue.main.sync { self.ensureObserver() }
            conn.send(["id": id, "ok": true, "result": ["registrations": registrations, "pid": Int(observedPid)]])
            return
        }
        axQueue.async {
            do {
                let result = try self.run(op, req)
                conn.send(["id": id, "ok": true, "result": result])
            } catch let e as BridgeError {
                conn.send(["id": id, "ok": false, "error": e.message, "code": Int(e.code)])
            } catch {
                conn.send(["id": id, "ok": false, "error": "\(error)"])
            }
        }
    }

    private func run(_ op: String, _ req: [String: Any]) throws -> Any {
        switch op {
        case "trusted":
            return AXIsProcessTrusted()
        case "pid":
            return targetPid().map { Int($0) } ?? NSNull()
        case "snapshot":
            let el = try element(path(req))
            var budget = (req["max_nodes"] as? Int) ?? 20000
            let attrs = (req["attrs"] as? [String]) ?? Self.defaultAttrs
            let all = (req["all_attrs"] as? Bool) ?? false
            return snapshot(el, path: path(req), depth: (req["depth"] as? Int) ?? 40, attrs: attrs, all: all, budget: &budget)
        case "attr_names":
            var names: CFArray?
            let err = AXUIElementCopyAttributeNames(try element(path(req)), &names)
            guard err == .success else { throw BridgeError(message: "attr_names_failed", code: err.rawValue) }
            return (names as? [String]) ?? []
        case "actions":
            var names: CFArray?
            let err = AXUIElementCopyActionNames(try element(path(req)), &names)
            guard err == .success else { throw BridgeError(message: "actions_failed", code: err.rawValue) }
            return (names as? [String]) ?? []
        case "perform":
            let el = try element(path(req))
            try expectRole(el, req)
            guard let action = req["action"] as? String else { throw BridgeError(message: "missing_action") }
            let err = AXUIElementPerformAction(el, action as CFString)
            guard err == .success else { throw BridgeError(message: "perform_failed", code: err.rawValue) }
            return true
        case "set":
            let el = try element(path(req))
            try expectRole(el, req)
            guard let attr = req["attr"] as? String, let value = req["value"] else { throw BridgeError(message: "missing_attr_or_value") }
            let cf: CFTypeRef
            switch value {
            case let b as Bool: cf = (b ? kCFBooleanTrue : kCFBooleanFalse)
            case let n as NSNumber: cf = n
            case let s as String: cf = s as CFString
            default: throw BridgeError(message: "unsupported_value")
            }
            let err = AXUIElementSetAttributeValue(el, attr as CFString, cf)
            guard err == .success else { throw BridgeError(message: "set_failed", code: err.rawValue) }
            return true
        case "param":
            let el = try element(path(req))
            guard let attr = req["attr"] as? String, let r = req["range"] as? [Int], r.count == 2 else {
                throw BridgeError(message: "missing_attr_or_range")
            }
            var range = CFRange(location: r[0], length: r[1])
            guard let rv = AXValueCreate(.cfRange, &range) else { throw BridgeError(message: "range_failed") }
            var out: CFTypeRef?
            let err = AXUIElementCopyParameterizedAttributeValue(el, attr as CFString, rv, &out)
            guard err == .success, let o = out else { throw BridgeError(message: "param_failed", code: err.rawValue) }
            return plain(o) ?? NSNull()
        default:
            throw BridgeError(message: "unknown_op:\(op)")
        }
    }

    // MARK: AX helpers

    private func targetPid() -> pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: TARGET_BUNDLE_ID).first?.processIdentifier
    }

    private func path(_ req: [String: Any]) -> [Int] { (req["path"] as? [Int]) ?? [] }

    private func element(_ path: [Int]) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw BridgeError(message: "not_trusted", code: AXError.apiDisabled.rawValue) }
        guard let pid = targetPid() else { throw BridgeError(message: "target_not_running") }
        var el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, 5.0)
        for (depth, i) in path.enumerated() {
            let kids = children(el)
            guard i >= 0, i < kids.count else { throw BridgeError(message: "stale_path_at_\(depth)") }
            el = kids[i]
        }
        return el
    }

    private func expectRole(_ el: AXUIElement, _ req: [String: Any]) throws {
        guard let want = req["expect_role"] as? String else { return }
        let got = copy(el, "AXRole").1.flatMap { plain($0) } as? String
        if got != want { throw BridgeError(message: "role_mismatch:\(got ?? "nil")") }
    }

    private func copy(_ el: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
        var v: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
        return (err, v)
    }

    private func children(_ el: AXUIElement) -> [AXUIElement] {
        guard let v = copy(el, "AXChildren").1, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
        return (v as! [AnyObject]).compactMap { o in
            CFGetTypeID(o) == AXUIElementGetTypeID() ? (o as! AXUIElement) : nil
        }
    }

    private func frame(_ el: AXUIElement) -> [Double]? {
        guard let p = copy(el, "AXPosition").1, let s = copy(el, "AXSize").1,
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero, sz = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
        return [Double(pt.x), Double(pt.y), Double(sz.width), Double(sz.height)]
    }

    private func plain(_ v: CFTypeRef) -> Any? {
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() { return v as! String }
        if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
        if t == CFNumberGetTypeID() { return v as! NSNumber }
        if t == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
        if t == CFURLGetTypeID() { return (v as! URL).absoluteString }
        if t == AXUIElementGetTypeID() { return nil }
        if t == AXValueGetTypeID() {
            let axv = v as! AXValue
            switch AXValueGetType(axv) {
            case .cgPoint: var p = CGPoint.zero; AXValueGetValue(axv, .cgPoint, &p); return [Double(p.x), Double(p.y)]
            case .cgSize: var s = CGSize.zero; AXValueGetValue(axv, .cgSize, &s); return [Double(s.width), Double(s.height)]
            case .cgRect:
                var r = CGRect.zero; AXValueGetValue(axv, .cgRect, &r)
                return [Double(r.origin.x), Double(r.origin.y), Double(r.width), Double(r.height)]
            case .cfRange: var r = CFRange(); AXValueGetValue(axv, .cfRange, &r); return [r.location, r.length]
            default: return nil
            }
        }
        if t == CFArrayGetTypeID() {
            let arr = v as! [AnyObject]
            if arr.contains(where: { CFGetTypeID($0) == AXUIElementGetTypeID() }) { return "<\(arr.count) elements>" }
            return arr.compactMap { plain($0) }
        }
        return String(describing: v)
    }

    private static let skipAll: Set<String> = ["AXChildren", "AXParent", "AXWindow", "AXTopLevelUIElement",
                                               "AXChildrenInNavigationOrder", "AXVisibleChildren"]

    private func snapshot(_ el: AXUIElement, path: [Int], depth: Int, attrs: [String], all: Bool,
                          budget: inout Int) -> [String: Any] {
        budget -= 1
        var names = attrs
        if all {
            var cf: CFArray?
            if AXUIElementCopyAttributeNames(el, &cf) == .success, let n = cf as? [String] {
                names = n.filter { !Self.skipAll.contains($0) }
            }
        }
        var values: [String: Any] = [:]
        for n in names {
            if let v = copy(el, n).1, let p = plain(v) {
                if let s = p as? String, s.isEmpty { continue }
                values[n] = p
            }
        }
        var node: [String: Any] = ["path": path, "role": values["AXRole"] ?? NSNull(), "attrs": values,
                                   "frame": frame(el) ?? NSNull()]
        var kids: [[String: Any]] = []
        if depth > 0 {
            for (i, ch) in children(el).enumerated() {
                if budget <= 0 { node["truncated"] = true; break }
                kids.append(snapshot(ch, path: path + [i], depth: depth - 1, attrs: attrs, all: all, budget: &budget))
            }
        }
        node["children"] = kids
        return node
    }

    // MARK: observer (main run loop)

    /// Called on the main thread; also from the app's periodic refresh to follow WhatsApp restarts.
    func ensureObserver() {
        lock.lock(); let wanted = !subscribers.isEmpty; lock.unlock()
        guard wanted, AXIsProcessTrusted(), let pid = targetPid() else { return }
        if observer != nil && pid == observedPid { return }
        if let old = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .defaultMode)
            observer = nil
        }
        let cb: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<AXBridge>.fromOpaque(refcon).takeUnretainedValue().emit(notification as String, element)
        }
        var obs: AXObserver?
        guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { return }
        let app = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var regs: [String: Int32] = [:]
        for n in Self.notifications {
            regs[n] = AXObserverAddNotification(o, app, n as CFString, refcon).rawValue
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
        observer = o
        observedPid = pid
        registrations = regs
    }

    private func emit(_ name: String, _ el: AXUIElement) {
        let role = copy(el, "AXRole").1.flatMap { plain($0) } as? String
        let ev: [String: Any] = ["event": name, "role": role ?? NSNull(), "t": Date().timeIntervalSince(started)]
        lock.lock(); let subs = Array(subscribers.values); lock.unlock()
        for s in subs { s.send(ev) }
    }
}
