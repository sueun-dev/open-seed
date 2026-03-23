import React, { useState } from "react";
import Pipeline from "./components/Pipeline";
import TaskLog from "./components/TaskLog";
import SnakeGame from "./components/SnakeGame";

export default function App() {
  const [tab, setTab] = useState<"pipeline" | "game">("pipeline");
  const [task, setTask] = useState("");
  const [workingDir, setWorkingDir] = useState("/tmp/openseed-output");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]);

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
        body: JSON.stringify({ task, working_dir: workingDir }),
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
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.style.borderColor = "#2563eb"; }}
            onDragLeave={(e) => { e.currentTarget.style.borderColor = "#222"; }}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation();
              e.currentTarget.style.borderColor = "#222";
              // Get folder path from dropped items
              const items = e.dataTransfer.items;
              if (items?.length) {
                for (let i = 0; i < items.length; i++) {
                  const entry = (items[i] as any).webkitGetAsEntry?.();
                  if (entry?.isDirectory) {
                    setWorkingDir(entry.fullPath || entry.name);
                    return;
                  }
                }
              }
              // Fallback: try file path from dataTransfer
              const files = e.dataTransfer.files;
              if (files.length > 0) {
                // Browser gives us the file name, but for folders we need the path
                const path = (files[0] as any).path || files[0].name;
                setWorkingDir(path);
              }
              // Also check text data (e.g., dragged from Finder path bar)
              const text = e.dataTransfer.getData("text/plain");
              if (text && text.startsWith("/")) setWorkingDir(text.trim());
            }}
            style={{
              display: "flex", gap: 8, marginBottom: 24, padding: "8px 12px",
              borderRadius: 8, border: "2px dashed #222", transition: "border-color 0.2s",
            }}
          >
            <span style={{ color: "#555", fontSize: 12, lineHeight: "32px", whiteSpace: "nowrap" }}>📁 Output:</span>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="Drag & drop a folder here, or type a path..."
              style={{
                flex: 1, padding: "6px 12px", borderRadius: 6,
                border: "none", background: "transparent", color: "#888",
                fontSize: 12, outline: "none", fontFamily: "monospace",
              }}
            />
            {workingDir && (
              <button
                onClick={() => setWorkingDir("")}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}
              >✕</button>
            )}
          </div>

          <Pipeline events={events} />
          <TaskLog events={events} />
        </>
      )}
    </div>
  );
}
