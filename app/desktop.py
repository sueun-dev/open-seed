"""Open Seed | Desktop App"""
import subprocess, sys, os, time, signal

PORT = 4040
APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(APP_DIR)
ICON_PATH = os.path.join(APP_DIR, "icon.png")
server_process = None

def kill_port():
    try:
        r = subprocess.run(["lsof", "-ti", f":{PORT}"], capture_output=True, text=True, timeout=3)
        for pid in r.stdout.strip().split("\n"):
            if pid.strip():
                try: os.kill(int(pid), signal.SIGTERM)
                except: pass
        time.sleep(0.5)
    except: pass

def start_server():
    global server_process
    env = os.environ.copy()
    env["OPENSEED_DESKTOP"] = "1"
    server_process = subprocess.Popen(
        ["node", os.path.join(APP_DIR, "server.js"), "--port", str(PORT), "--cwd", PROJECT_DIR],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env
    )

def wait_for_server(timeout=15):
    import urllib.request
    for _ in range(timeout * 4):
        try:
            urllib.request.urlopen(f"http://localhost:{PORT}", timeout=1)
            return True
        except: time.sleep(0.25)
    return False

def main():
    import webview
    try:
        from AppKit import NSApplication, NSImage, NSProcessInfo, NSApplicationActivationPolicyRegular
        from Foundation import NSBundle
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
        icon = NSImage.alloc().initWithContentsOfFile_(ICON_PATH)
        if icon: app.setApplicationIconImage_(icon)
        NSProcessInfo.processInfo().setValue_forKey_("Open Seed", "processName")
        b = NSBundle.mainBundle()
        info = b.localizedInfoDictionary() or b.infoDictionary()
        if info:
            info["CFBundleName"] = "Open Seed"
            info["CFBundleDisplayName"] = "Open Seed"
    except: pass

    kill_port()
    start_server()
    if not wait_for_server():
        if server_process: server_process.terminate()
        sys.exit(1)

    def on_closing():
        if server_process:
            server_process.terminate()
            try: server_process.wait(timeout=3)
            except: server_process.kill()

    def on_shown():
        try:
            from AppKit import NSApplication
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        except: pass

    w = webview.create_window("Open Seed", f"http://localhost:{PORT}",
        width=1440, height=900, min_size=(900, 600),
        background_color="#0d1117", text_select=True)
    w.events.closing += on_closing
    w.events.shown += on_shown
    webview.start(debug=False)
    if server_process: server_process.terminate()

if __name__ == "__main__":
    main()
