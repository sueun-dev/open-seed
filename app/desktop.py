"""
Open Seed | Desktop App
Click to launch. Server starts automatically. No terminal needed.
"""
import subprocess
import sys
import os
import time

PORT = 4040
APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(APP_DIR)
ICON_PATH = os.path.join(APP_DIR, "icon.png")


def set_dock_icon():
    """Set Dock icon + app name on macOS."""
    try:
        from AppKit import NSApplication, NSImage, NSProcessInfo
        from Foundation import NSBundle
        app = NSApplication.sharedApplication()
        icon = NSImage.alloc().initWithContentsOfFile_(ICON_PATH)
        if icon:
            app.setApplicationIconImage_(icon)
        NSProcessInfo.processInfo().setValue_forKey_("Open Seed", "processName")
        bundle = NSBundle.mainBundle()
        info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
        if info:
            info["CFBundleName"] = "Open Seed"
            info["CFBundleDisplayName"] = "Open Seed"
    except Exception:
        pass


def kill_existing_server():
    """Kill any existing server on our port."""
    try:
        import signal
        result = subprocess.run(
            ["lsof", "-ti", f":{PORT}"],
            capture_output=True, text=True, timeout=3
        )
        for pid in result.stdout.strip().split("\n"):
            if pid.strip():
                try:
                    os.kill(int(pid.strip()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        time.sleep(0.5)
    except Exception:
        pass


def start_server():
    """Start the Node.js web server."""
    server_js = os.path.join(APP_DIR, "server.js")
    env = os.environ.copy()
    env["OPENSEED_DESKTOP"] = "1"  # Prevent server from opening browser
    return subprocess.Popen(
        ["node", server_js, "--port", str(PORT), "--cwd", PROJECT_DIR],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env
    )


def wait_for_server(timeout=15):
    """Wait until server responds."""
    import urllib.request
    for _ in range(timeout * 4):
        try:
            urllib.request.urlopen(f"http://localhost:{PORT}", timeout=1)
            return True
        except Exception:
            time.sleep(0.25)
    return False


def main():
    import webview

    set_dock_icon()
    kill_existing_server()

    server = start_server()

    if not wait_for_server():
        print("Server failed to start")
        server.terminate()
        sys.exit(1)

    def on_closing():
        server.terminate()
        try:
            server.wait(timeout=3)
        except Exception:
            server.kill()

    window = webview.create_window(
        title="Open Seed",
        url=f"http://localhost:{PORT}",
        width=1440,
        height=900,
        min_size=(900, 600),
        background_color="#0d1117",
        text_select=True,
    )
    window.events.closing += on_closing
    webview.start(debug=False)
    server.terminate()


if __name__ == "__main__":
    main()
