import Cocoa
import WebKit

class WindowDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

class DropWebView: WKWebView {
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        return .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] else { return false }
        for url in urls {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                let escaped = url.path.replacingOccurrences(of: "'", with: "\\'")
                let js = "if(typeof setAgiTarget==='function')setAgiTarget('\(escaped)')"
                DispatchQueue.main.async { self.evaluateJavaScript(js, completionHandler: nil) }
                return true
            }
        }
        return false
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    let port = 4040

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        // Show window immediately with dark background, then load when server is ready
        createWindow()
        pollServerAndLoad()
    }

    func pollServerAndLoad(attempt: Int = 0) {
        let url = URL(string: "http://localhost:\(port)")!
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async { self?.webView.load(URLRequest(url: url)) }
            } else if attempt < 60 {
                // Retry every 100ms, up to 6 seconds
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self?.pollServerAndLoad(attempt: attempt + 1)
                }
            }
        }
        task.resume()
    }

    func startServer() {
        let appPath = Bundle.main.resourcePath ?? "."
        let serverJs = appPath + "/server.js"
        // Server manages workspace via ~/.openseed/workspaces.json
        // Only pass --cwd if OPENSEED_CWD env is explicitly set
        let envCwd = ProcessInfo.processInfo.environment["OPENSEED_CWD"]
        let home: String? = (envCwd != nil && FileManager.default.fileExists(atPath: envCwd!)) ? envCwd : nil

        // Find node via login shell
        var nodeBin = "/usr/local/bin/node"
        let shellProc = Process()
        shellProc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shellProc.arguments = ["-lc", "which node"]
        let pipe = Pipe()
        shellProc.standardOutput = pipe
        shellProc.standardError = FileHandle.nullDevice
        do {
            try shellProc.run()
            shellProc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !path.isEmpty, FileManager.default.fileExists(atPath: path) {
                nodeBin = path
            }
        } catch {}

        // Fallback
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/Volumes/DevSSD/Developer/Toolchains/node/current/bin/node"
        ]
        if !FileManager.default.fileExists(atPath: nodeBin) {
            for p in candidates {
                if FileManager.default.fileExists(atPath: p) { nodeBin = p; break }
            }
        }

        NSLog("[Open Seed] node: \(nodeBin)")
        NSLog("[Open Seed] server: \(serverJs)")
        NSLog("[Open Seed] cwd: \(home ?? "(none — will use workspace history)")")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let cwdArg = home != nil ? " --cwd '\(home!)'" : ""
        proc.arguments = ["-lc", "exec '\(nodeBin)' '\(serverJs)' --port \(port)\(cwdArg)"]
        var env = ProcessInfo.processInfo.environment
        env["OPENSEED_DESKTOP"] = "1"
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            serverProcess = proc
            NSLog("[Open Seed] Server started with PID \(proc.processIdentifier)")
        } catch {
            NSLog("[Open Seed] Failed to start server: \(error)")
        }
    }

    func createWindow() {
        let screenFrame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = 1440
        let windowHeight: CGFloat = 900
        let x = (screenFrame.width - windowWidth) / 2
        let y = (screenFrame.height - windowHeight) / 2

        window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Open Seed"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false

        // Add a transparent drag bar over the title bar area
        // so the user can drag the window from the top
        let titleBarHeight: CGFloat = 28
        let dragBar = WindowDragView(frame: NSRect(x: 70, y: 0, width: 9999, height: titleBarHeight))
        dragBar.autoresizingMask = [.width]
        // Add it to the titlebar container (above webview)
        if let titlebarView = window.standardWindowButton(.closeButton)?.superview {
            dragBar.frame = NSRect(x: 70, y: 0, width: titlebarView.bounds.width - 70, height: titlebarView.bounds.height)
            dragBar.autoresizingMask = [.width, .height]
            titlebarView.addSubview(dragBar)
        }
        window.backgroundColor = NSColor(red: 0.051, green: 0.067, blue: 0.09, alpha: 1.0)
        window.minSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = DropWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.customUserAgent = "OpenSeed-Desktop/0.1"
        webView.registerForDraggedTypes([.fileURL])
        window.contentView?.addSubview(webView)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }


    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

// Setup menu bar
let mainMenu = NSMenu()
let appMenuItem = NSMenuItem()
mainMenu.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "About Open Seed", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
appMenu.addItem(.separator())
appMenu.addItem(withTitle: "Hide Open Seed", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(.separator())
appMenu.addItem(withTitle: "Quit Open Seed", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenuItem.submenu = appMenu

let editMenuItem = NSMenuItem()
mainMenu.addItem(editMenuItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector("undo:"), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector("redo:"), keyEquivalent: "Z")
editMenu.addItem(.separator())
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editMenuItem.submenu = editMenu

let viewMenuItem = NSMenuItem()
mainMenu.addItem(viewMenuItem)
let viewMenu = NSMenu(title: "View")
viewMenu.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
viewMenuItem.submenu = viewMenu

app.mainMenu = mainMenu
app.run()
