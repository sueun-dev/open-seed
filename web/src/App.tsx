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
            style={{
              display: "flex", gap: 8, marginBottom: 24, padding: "8px 12px",
              borderRadius: 8, border: "1px solid #222",
            }}
          >
            <span style={{ color: "#555", fontSize: 12, lineHeight: "32px", whiteSpace: "nowrap" }}>📁 Output:</span>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="Click Browse to select folder, or type full path..."
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
