#!/bin/bash
# Open Seed — Desktop App Launcher
# Starts the server and opens a native macOS window

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=4040

# Kill existing server on this port
lsof -ti :$PORT | xargs kill -9 2>/dev/null
sleep 0.5

# Start server in background
node "$SCRIPT_DIR/server.js" --port $PORT --cwd "$SCRIPT_DIR/.." &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:$PORT/ 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Open native macOS window using Swift
swift - <<'SWIFT'
import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        window.backgroundColor = NSColor(red: 0.051, green: 0.067, blue: 0.09, alpha: 1.0) // #0d1117
        window.minSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(webView)

        if let url = URL(string: "http://localhost:4040") {
            webView.load(URLRequest(url: url))
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringAllApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
SWIFT

# Clean up server when window closes
kill $SERVER_PID 2>/dev/null
