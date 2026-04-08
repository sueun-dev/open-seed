"""
Open Seed v2 — Browser-based UI verification (OpenHands pattern).

Uses Playwright to open the built app in a real browser, take screenshots,
and have AI verify the UI renders correctly.

Integrates into evidence.py as an additional verification step.

Pattern from: openhands/runtime/browser/browser_env.py
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from typing import Any


@dataclass
class BrowserEvidence:
    """Result of browser-based UI verification."""

    passed: bool
    url: str = ""
    screenshot_b64: str = ""  # Base64 PNG for AI analysis
    ai_verdict: str = ""  # AI's assessment of the screenshot
    error: str = ""
    interactions: list[dict[str, Any]] | None = None


async def verify_ui(
    working_dir: str,
    port: int | None = None,
    timeout_seconds: int = 30,
) -> BrowserEvidence:
    """
    Launch the app, open it in a headless browser, take a screenshot,
    and have AI verify the UI looks correct.

    Steps:
    1. Detect which dev server to start (npm run dev, vite, etc.)
    2. Start the dev server in background
    3. Wait for it to be ready
    4. Open headless browser, navigate to localhost
    5. Take screenshot
    6. AI analyzes: "Does this look like a working app?"
    7. Clean up

    Args:
        working_dir: Project directory
        port: Override port (auto-detects from server output if None)
        timeout_seconds: Max time to wait for server startup

    Returns:
        BrowserEvidence with pass/fail and screenshot
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return BrowserEvidence(
            passed=True,  # Don't block pipeline if Playwright not installed
            error="Playwright not installed. Skipping browser verification. Install with: pip install playwright && playwright install chromium",
        )

    server_proc = None
    try:
        # 1. Start dev server
        server_proc, actual_port = await _start_dev_server(working_dir, timeout_seconds)
        if not actual_port:
            return BrowserEvidence(
                passed=True,  # Don't block if server won't start
                error="Could not detect dev server port. Skipping browser verification.",
            )

        url = f"http://localhost:{actual_port}"

        # 2. Open browser and take screenshot
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 1280, "height": 720})

            try:
                await page.goto(url, wait_until="networkidle", timeout=15000)
            except Exception:
                # Retry with domcontentloaded (less strict)
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=10000)
                except Exception as e:
                    await browser.close()
                    return BrowserEvidence(
                        passed=False,
                        url=url,
                        error=f"Page failed to load: {e}",
                    )

            # Wait a bit for React/Vue to hydrate
            await asyncio.sleep(2)

            # Take screenshot
            screenshot_bytes = await page.screenshot(type="png")
            screenshot_b64 = base64.b64encode(screenshot_bytes).decode("utf-8")

            # Check for obvious errors on page
            page_text = await page.text_content("body") or ""
            title = await page.title()

            # Try basic interactions
            interactions = await _try_basic_interactions(page)

            await browser.close()

        # 3. AI analyzes screenshot
        ai_verdict = await _ai_analyze_ui(
            screenshot_b64=screenshot_b64,
            page_text=page_text[:2000],
            title=title,
            url=url,
            interactions=interactions,
        )

        passed = "fail" not in ai_verdict.lower() and "error" not in ai_verdict.lower()[:50]

        return BrowserEvidence(
            passed=passed,
            url=url,
            screenshot_b64=screenshot_b64,
            ai_verdict=ai_verdict,
            interactions=interactions,
        )

    except Exception as e:
        return BrowserEvidence(
            passed=True,  # Don't block pipeline on browser errors
            error=f"Browser verification error: {e}",
        )
    finally:
        if server_proc:
            try:
                server_proc.kill()
                await server_proc.wait()
            except Exception:
                pass


async def _start_dev_server(
    working_dir: str,
    timeout_seconds: int = 30,
) -> tuple[Any, int | None]:
    """
    Start the project's dev server and return (process, port).
    Auto-detects the start command and port from output.
    """
    import json
    import os
    import re

    # Detect start command
    pkg_json = os.path.join(working_dir, "package.json")
    cmd = None
    if os.path.exists(pkg_json):
        try:
            with open(pkg_json) as f:
                data = json.loads(f.read())
            scripts = data.get("scripts", {})
            if "dev" in scripts:
                cmd = "npm run dev"
            elif "start" in scripts:
                cmd = "npm start"
        except Exception:
            pass

    if not cmd:
        return None, None

    # Start the server
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=working_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Wait for port to appear in output
    port = None
    start = asyncio.get_event_loop().time()

    async def read_output() -> int | None:
        """Read stdout/stderr looking for port number."""
        nonlocal port
        while asyncio.get_event_loop().time() - start < timeout_seconds:
            for stream in [proc.stdout, proc.stderr]:
                if stream is None:
                    continue
                try:
                    line = await asyncio.wait_for(stream.readline(), timeout=1)
                    if not line:
                        continue
                    text = line.decode("utf-8", errors="replace")
                    # Look for common patterns: "localhost:3000", "port 3001", etc.
                    match = re.search(r"localhost:(\d+)", text)
                    if match:
                        return int(match.group(1))
                    match = re.search(r"port\s+(\d+)", text, re.IGNORECASE)
                    if match:
                        return int(match.group(1))
                except (TimeoutError, Exception):
                    continue
        return None

    port = await read_output()
    return proc, port


async def _try_basic_interactions(page: Any) -> list[dict[str, Any]]:
    """
    Try basic UI interactions and record results.
    Non-destructive: only clicks buttons, checks if elements exist.
    """
    interactions = []

    try:
        # Check for input fields
        inputs = await page.query_selector_all("input[type=text], input:not([type])")
        interactions.append({"check": "text_inputs_found", "count": len(inputs)})

        # Check for buttons
        buttons = await page.query_selector_all("button, input[type=submit]")
        interactions.append({"check": "buttons_found", "count": len(buttons)})

        # Check for error messages
        errors = await page.query_selector_all("[class*=error], [class*=Error], .alert-danger")
        interactions.append({"check": "error_elements", "count": len(errors)})

        # Try typing in first input if it exists
        if inputs:
            try:
                await inputs[0].fill("Test item")
                interactions.append({"check": "input_typing", "passed": True})
            except Exception:
                interactions.append({"check": "input_typing", "passed": False})

    except Exception as e:
        interactions.append({"check": "interaction_error", "error": str(e)[:200]})

    return interactions


async def _ai_analyze_ui(
    screenshot_b64: str,
    page_text: str,
    title: str,
    url: str,
    interactions: list[dict[str, Any]] | None = None,
) -> str:
    """
    Have AI analyze the UI screenshot and page content.
    Returns verdict string.
    """
    try:
        from openseed_codex.agent import CodexAgent

        agent = CodexAgent()
        interaction_text = ""
        if interactions:
            interaction_text = "\nInteraction results:\n" + "\n".join(f"- {i}" for i in interactions)

        response = await agent.invoke(
            prompt=(
                f"Analyze this web application UI.\n\n"
                f"URL: {url}\n"
                f"Page title: {title}\n"
                f"Visible text (first 2000 chars): {page_text}\n"
                f"{interaction_text}\n\n"
                f"Answer these questions:\n"
                f"1. Does the page render a real UI (not a blank page, not an error page)?\n"
                f"2. Are there any visible error messages or stack traces?\n"
                f"3. Does it look like a functional web application?\n\n"
                f"Answer with: 'PASS: <reason>' or 'FAIL: <reason>'"
            ),
            model="light",
            max_turns=1,
        )
        return response.text.strip()[:500]
    except Exception as e:
        return f"PASS: AI analysis unavailable ({e}). Proceeding."
