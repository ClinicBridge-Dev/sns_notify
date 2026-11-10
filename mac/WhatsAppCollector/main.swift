// WhatsApp 수집기 — menu bar launcher.
//
// Why this exists: macOS grants 손쉬운 사용 (Accessibility) per *app*, and does NOT extend the grant
// to processes the app spawns (verified on-device). So this app performs every AX call itself
// (Bridge.swift) and serves them to the Python collector over a private channel on the child's fd 0.
// It keeps the collector alive (restart with backoff), prevents idle sleep, and offers a
// diagnostic "화면 구조 기록" that runs the AX dump under the same permission.
//
// Configuration: ~/Library/Application Support/WhatsAppCollector/launcher.json (written by
// scripts/install_app.sh) or the path in $LW_LAUNCHER_CONFIG. The bundle itself never changes when
// the Python code changes, so the permission grant survives code updates.

import AppKit
import ApplicationServices
import IOKit.pwr_mgt

struct LauncherConfig: Decodable {
    var repo: String
    var python: String?
    var viewer_url: String?
    var prompt_accessibility: Bool?
    var args: [String]?
    /// Development only: allow wacollector://<action> URLs (dump, find, observe, read, check) so a
    /// developer can run diagnostics under this app's permission without clicking the menu.
    var debug_actions: Bool?

    var pythonPath: String { python ?? (repo as NSString).appendingPathComponent(".venv/bin/python") }
    var viewerURL: URL { URL(string: viewer_url ?? "http://localhost:8787")! }
    var appArgs: [String] { args ?? ["-m", "app.main", "--config", "config.yaml", "--env", ".env", "--log-dir", "logs"] }

    static var path: String {
        if let p = ProcessInfo.processInfo.environment["LW_LAUNCHER_CONFIG"], !p.isEmpty { return p }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WhatsAppCollector/launcher.json").path
    }

    static func load() -> Result<LauncherConfig, Error> {
        Result {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            return try JSONDecoder().decode(LauncherConfig.self, from: data)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let stateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let trustItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")

    private var config: LauncherConfig?
    private var configError: String?
    private var child: Process?
    private var childStartedAt = Date.distantPast
    private var backoff: TimeInterval = 2
    private var restartPending = false
    private var stopping = false
    private var lastExit: String?
    private var sleepAssertion: IOPMAssertionID = 0
    private var timer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private let bridge = AXBridge()  // every Accessibility call happens in this process

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A URL open can make LaunchServices start a second copy; only one may run the collector.
        let me = ProcessInfo.processInfo.processIdentifier
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .contains(where: { $0.processIdentifier != me }) {
            exit(0)
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()

        switch LauncherConfig.load() {
        case .success(let c): config = c
        case .failure(let e): configError = "설정 파일 없음: \(LauncherConfig.path) (\(e.localizedDescription))"
        }

        if let c = config, c.prompt_accessibility ?? true, !AXIsProcessTrusted() {
            // Shows the system dialog that points the user at 손쉬운 사용 for *this* app.
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }

        IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                    IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                    "WhatsApp 수집기 실행 중" as CFString, &sleepAssertion)

        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in self?.quit() }
            src.resume()
            signalSources.append(src)
        }

        startChild()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    // MARK: menu

    private func buildMenu() {
        menu.autoenablesItems = false
        stateItem.isEnabled = false
        trustItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(trustItem)
        menu.addItem(.separator())
        menu.addItem(item("대화 화면 열기", #selector(openViewer), "o"))
        menu.addItem(item("손쉬운 사용 설정 열기…", #selector(openAccessibilitySettings), ""))
        menu.addItem(item("화면 구조 기록 (진단)", #selector(runDump), ""))
        menu.addItem(item("로그 폴더 열기", #selector(openLogs), "l"))
        menu.addItem(.separator())
        menu.addItem(item("수집기 다시 시작", #selector(restartChild), "r"))
        menu.addItem(item("종료", #selector(quitFromMenu), "q"))
        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    private func refresh() {
        bridge.ensureObserver()  // follow WhatsApp restarts for subscribed children
        let trusted = AXIsProcessTrusted()
        let running = child?.isRunning ?? false
        let symbol: String
        if configError != nil {
            stateItem.title = "⚠︎ " + (configError ?? "")
            symbol = "exclamationmark.bubble"
        } else if running {
            let mins = Int(Date().timeIntervalSince(childStartedAt) / 60)
            stateItem.title = "수집기 실행 중 (\(mins)분째)"
            symbol = trusted ? "bubble.left.and.bubble.right.fill" : "exclamationmark.bubble"
        } else {
            stateItem.title = "수집기 재시작 대기" + (lastExit.map { " — \($0)" } ?? "")
            symbol = "exclamationmark.bubble"
        }
        trustItem.title = trusted ? "손쉬운 사용 권한: 허용됨" : "손쉬운 사용 권한: 필요 (설정에서 이 앱을 켜 주세요)"
        if let b = statusItem.button {
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "WhatsApp 수집기")
            b.toolTip = "WhatsApp 수집기 — \(stateItem.title)"
        }
    }

    // MARK: child process

    private func logHandle(_ name: String) -> FileHandle? {
        guard let c = config else { return nil }
        let dir = (c.repo as NSString).appendingPathComponent("logs")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let path = (dir as NSString).appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let h = FileHandle(forWritingAtPath: path)
        h?.seekToEndOfFile()
        return h
    }

    private func makeProcess(_ args: [String]) -> Process? {
        guard let c = config else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: c.pythonPath)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: c.repo)
        var env = ProcessInfo.processInfo.environment
        env["PYTHONUNBUFFERED"] = "1"
        env.removeValue(forKey: "LW_LAUNCHER_CONFIG")
        p.environment = env
        return p
    }

    private func startChild() {
        restartPending = false
        guard !stopping, let c = config, let p = makeProcess(c.appArgs) else { refresh(); return }
        if let h = logHandle("collector.out.log") { p.standardOutput = h; p.standardError = h }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.childExited(proc) }
        }
        do {
            try bridge.launch(p)
            child = p
            childStartedAt = Date()
        } catch {
            lastExit = "실행 실패: \(error.localizedDescription)"
            scheduleRestart()
        }
        refresh()
    }

    private func childExited(_ proc: Process) {
        guard proc === child else { return }
        lastExit = "종료 코드 \(proc.terminationStatus)"
        if stopping { return }
        // A child that ran for a while gets a fresh backoff; a crash loop backs off up to 60s.
        if Date().timeIntervalSince(childStartedAt) > 60 { backoff = 2 }
        scheduleRestart()
        refresh()
    }

    private func scheduleRestart() {
        guard !restartPending, !stopping else { return }
        restartPending = true
        let delay = backoff
        backoff = min(backoff * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.startChild() }
    }

    private func stopChild(then: @escaping () -> Void) {
        guard let p = child, p.isRunning else { then(); return }
        p.terminate()  // SIGTERM: uvicorn/asyncio shut down cleanly
        let pid = p.processIdentifier
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(8)
            while p.isRunning && Date() < deadline { usleep(100_000) }
            if p.isRunning { kill(pid, SIGKILL) }
            DispatchQueue.main.async(execute: then)
        }
    }

    // MARK: actions

    @objc private func openViewer() {
        if let c = config { NSWorkspace.shared.open(c.viewerURL) }
    }

    @objc private func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    @objc private func openLogs() {
        if let c = config { NSWorkspace.shared.open(URL(fileURLWithPath: (c.repo as NSString).appendingPathComponent("logs"))) }
    }

    @objc private func restartChild() {
        backoff = 2
        stopChild { [weak self] in
            self?.child = nil
            self?.startChild()
        }
    }

    @objc private func runDump() {
        guard let p = makeProcess(["scripts/ax_dump.py", "dump"]) else { return }
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.terminationHandler = { proc in
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                let a = NSAlert()
                a.messageText = proc.terminationStatus == 0 ? "화면 구조를 기록했습니다" : "화면 구조를 기록하지 못했습니다"
                a.informativeText = String(out.suffix(1500))
                a.runModal()
            }
        }
        do { try bridge.launch(p) } catch {
            let a = NSAlert()
            a.messageText = "실행 실패: \(error.localizedDescription)"
            a.runModal()
        }
    }

    // MARK: development diagnostics (wacollector://...)

    func application(_ application: NSApplication, open urls: [URL]) {
        guard config?.debug_actions == true else { return }
        for url in urls { runDiagnostic(url) }
    }

    private func runDiagnostic(_ url: URL) {
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func param(_ k: String) -> String? { q.first(where: { $0.name == k })?.value }
        var args = ["scripts/ax_dump.py"]
        switch url.host ?? "" {
        case "check": args.append("check")
        case "dump": args.append("dump")
        case "read": args += ["read", "--limit", param("limit") ?? "30"]
        case "find":
            guard let t = param("text"), !t.isEmpty else { return }
            args += ["find", t]
        case "observe": args += ["observe", "--seconds", param("seconds") ?? "60"]
        default: return
        }
        guard let c = config, let p = makeProcess(args) else { return }
        let dir = (c.repo as NSString).appendingPathComponent("ax_dumps")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let out = (dir as NSString).appendingPathComponent("last-action.log")
        FileManager.default.createFile(atPath: out, contents: nil, attributes: [.posixPermissions: 0o600])
        if let h = FileHandle(forWritingAtPath: out) {
            h.write("$ \(args.joined(separator: " "))\n".data(using: .utf8)!)
            p.standardOutput = h
            p.standardError = h
            p.terminationHandler = { proc in
                h.write("\n[exit \(proc.terminationStatus)]\n".data(using: .utf8)!)
                try? h.close()
            }
        }
        try? bridge.launch(p)
    }

    @objc private func quitFromMenu() { quit() }

    private func quit() {
        stopping = true
        stopChild {
            if self.sleepAssertion != 0 { IOPMAssertionRelease(self.sleepAssertion) }
            exit(0)  // exit 0: the LaunchAgent (KeepAlive SuccessfulExit=false) will not relaunch
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        child?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
app.run()
