import React, { useState } from "react";
import Pipeline from "./components/Pipeline";
import TaskLog from "./components/TaskLog";
import SnakeGame from "./components/SnakeGame";
import FolderBrowser from "./components/FolderBrowser";

export default function App() {
  const [tab, setTab] = useState<"pipeline" | "game">("pipeline");
  const [task, setTask] = useState("");
  const [workingDir, setWorkingDir] = useState("/tmp/openseed-output");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");

  const startRun = async () => {
    if (!task.trim() || running) return;
    setRunning(true);
    setEvents([]);

    try {
      // Connect WebSocket FIRST so we don't miss events
      const ws = new WebSocket(`ws://${location.host}/ws/events`);
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          setEvents((prev) => [...prev, event]);
          if (event.type === "pipeline.complete" || event.type === "pipeline.fail") {
            setRunning(false);
            setTimeout(() => ws.close(), 1000);
          }
        } catch {}
      };
      ws.onerror = () => setRunning(false);
      ws.onclose = () => setRunning(false);

      // Wait for WS connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        setTimeout(resolve, 1000);
      });

      // Start pipeline
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, working_dir: workingDir, provider }),
      });
      const data = await res.json();
      if (data.error) {
        setEvents((prev) => [...prev, { type: "error", data: { message: data.error } }]);
        setRunning(false);
        ws.close();
      }
    } catch (err) {
      setEvents((prev) => [...prev, { type: "error", data: { message: String(err) } }]);
      setRunning(false);
    }
  };

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "system-ui", background: "#0a0a0a", minHeight: "100vh", color: "#eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: "#fff", margin: 0 }}>Open Seed v2</h1>
        <div style={{ display: "flex", gap: 4 }}>
          {(["pipeline", "game"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "6px 16px", borderRadius: 6, border: "1px solid #333",
              background: tab === t ? "#2563eb" : "#111", color: tab === t ? "#fff" : "#888",
              fontWeight: 700, cursor: "pointer", fontSize: 13, textTransform: "capitalize",
            }}>{t === "game" ? "🐍 Snake" : "Pipeline"}</button>
          ))}
        </div>
      </div>
      <p style={{ color: "#666", marginBottom: 24, fontSize: 13 }}>Zero-Bug Autonomous AGI Coding Engine — 7 systems, 2 AI providers, 0 errors</p>

      {tab === "game" ? <SnakeGame /> : (
        <>
          {/* Provider selector */}
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {(["claude", "codex", "both"] as const).map((p) => (
              <button key={p} onClick={() => setProvider(p)} style={{
                padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: provider === p ? "1px solid #2563eb" : "1px solid #333",
                background: provider === p ? "#1e3a5f" : "#111",
                color: provider === p ? "#60a5fa" : "#666",
              }}>
                {p === "claude" ? "🟣 Claude" : p === "codex" ? "🟢 Codex" : "⚡ Both"}
              </button>
            ))}
            <span style={{ color: "#444", fontSize: 11, lineHeight: "28px", marginLeft: 8 }}>
              {provider === "claude" ? "Deep reasoning (Opus/Sonnet)" : provider === "codex" ? "Fast parallel (GPT-5)" : "Claude designs + Codex builds"}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startRun()}
              placeholder="Describe what to build..."
              style={{
                flex: 1, padding: "12px 16px", borderRadius: 8,
                border: "1px solid #333", background: "#111", color: "#eee",
                fontSize: 14, outline: "none",
              }}
            />
            <button
              onClick={startRun}
              disabled={running || !task.trim()}
              style={{
                padding: "12px 24px", borderRadius: 8, border: "none",
                background: running ? "#333" : "#2563eb", color: "#fff",
                fontWeight: 700, cursor: running ? "default" : "pointer",
                fontSize: 14,
              }}
            >
              {running ? "Running..." : "Run"}
            </button>
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.background = "#0c1a2e"; }}
            onDragLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.background = "transparent"; }}
            onDrop={async (e) => {
              e.preventDefault(); e.stopPropagation();
              e.currentTarget.style.borderColor = "#222";
              e.currentTarget.style.background = "transparent";
              // Get folder name from drop
              let folderName = "";
              const items = e.dataTransfer.items;
              if (items?.length) {
                for (let i = 0; i < items.length; i++) {
                  const entry = (items[i] as any).webkitGetAsEntry?.();
                  if (entry?.isDirectory) { folderName = entry.name; break; }
                }
              }
              if (!folderName) {
                const files = e.dataTransfer.files;
                if (files.length > 0) folderName = (files[0] as any).path || files[0].name;
              }
              if (!folderName) {
                const text = e.dataTransfer.getData("text/plain");
                if (text) folderName = text.trim();
              }
              if (!folderName) return;
              // If already absolute path, use directly
              if (folderName.startsWith("/")) { setWorkingDir(folderName); return; }
              // Resolve folder name to full path via server
              try {
                const res = await fetch(`/api/resolve-folder?name=${encodeURIComponent(folderName)}`);
                const data = await res.json();
                if (data.matches?.length === 1) {
                  setWorkingDir(data.matches[0]);
                } else if (data.matches?.length > 1) {
                  // Show picker for multiple matches
                  const choice = window.prompt(
                    `Multiple folders named "${folderName}" found:\n\n${data.matches.map((m: string, i: number) => `${i + 1}. ${m}`).join("\n")}\n\nEnter number:`,
                    "1"
                  );
                  const idx = parseInt(choice || "1", 10) - 1;
                  if (idx >= 0 && idx < data.matches.length) setWorkingDir(data.matches[idx]);
                } else {
                  setWorkingDir("/" + folderName); // Fallback
                }
              } catch { setWorkingDir("/" + folderName); }
            }}
            style={{
              display: "flex", gap: 8, marginBottom: 24, padding: "8px 12px",
              borderRadius: 8, border: "2px dashed #222", transition: "all 0.2s",
            }}
          >
            <span style={{ color: "#555", fontSize: 12, lineHeight: "32px", whiteSpace: "nowrap" }}>📁 Output:</span>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="Drag folder here, Browse, or type full path..."
              style={{
                flex: 1, padding: "6px 12px", borderRadius: 6,
                border: "none", background: "transparent", color: "#888",
                fontSize: 12, outline: "none", fontFamily: "monospace",
              }}
            />
            <button
              onClick={() => setShowBrowser(true)}
              style={{
                background: "#1a1a1a", border: "1px solid #333", borderRadius: 6,
                color: "#888", cursor: "pointer", padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap",
              }}
            >📁 Browse</button>
            {workingDir && (
              <button
                onClick={() => setWorkingDir("")}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}
              >✕</button>
            )}
          </div>

          {showBrowser && (
            <FolderBrowser
              onSelect={(path) => setWorkingDir(path)}
              onClose={() => setShowBrowser(false)}
            />
          )}

          <Pipeline events={events} />
          <TaskLog events={events} />
        </>
      )}
    </div>
  );
}
