"""
Open Seed | Desktop App
Native macOS window using system WebKit.
No Electron, no Chrome, no signing required.
"""
import subprocess
import sys
import os
import time
import threading

PORT = 4040
APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(APP_DIR)

def start_server():
    """Start the Node.js web server."""
    server_js = os.path.join(APP_DIR, "server.js")
    env = os.environ.copy()
    return subprocess.Popen(
        ["node", server_js, "--port", str(PORT), "--cwd", PROJECT_DIR],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env
    )

def wait_for_server(timeout=15):
    """Wait until server is ready."""
    import urllib.request
    for _ in range(timeout * 4):
        try:
            urllib.request.urlopen(f"http://localhost:{PORT}", timeout=1)
            return True
        except:
            time.sleep(0.25)
    return False

def main():
    import webview

    # Start server in background
    server = start_server()

    def on_closing():
        server.terminate()
        try:
            server.wait(timeout=3)
        except:
            server.kill()

    # Wait for server
    if not wait_for_server():
        print("Server failed to start")
        server.terminate()
        sys.exit(1)

    # Create native window
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

    # Start the GUI (blocks until window is closed)
    webview.start(debug=False)

    # Cleanup
    server.terminate()

if __name__ == "__main__":
    main()
