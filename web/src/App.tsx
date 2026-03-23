import React, { useState } from "react";
import Pipeline from "./components/Pipeline";
import TaskLog from "./components/TaskLog";

export default function App() {
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]);

  const startRun = async () => {
    if (!task.trim() || running) return;
    setRunning(true);
    setEvents([]);

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      setEvents((prev) => [...prev, { type: "started", data }]);

      // Connect WebSocket for events
      const ws = new WebSocket(`ws://${location.host}/ws/events`);
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data);
        setEvents((prev) => [...prev, event]);
        if (event.type === "pipeline.complete" || event.type === "pipeline.fail") {
          setRunning(false);
          ws.close();
        }
      };
      ws.onclose = () => setRunning(false);
    } catch (err) {
      setEvents((prev) => [...prev, { type: "error", data: { message: String(err) } }]);
      setRunning(false);
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Open Seed v2</h1>
      <p style={{ color: "#888", marginBottom: 24 }}>Zero-Bug Autonomous AGI Coding Engine</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && startRun()}
          placeholder="Describe a task..."
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 8,
            border: "1px solid #333", background: "#111", color: "#eee",
            fontSize: 14, outline: "none",
          }}
        />
        <button
          onClick={startRun}
          disabled={running || !task.trim()}
          style={{
            padding: "10px 20px", borderRadius: 8, border: "none",
            background: running ? "#333" : "#2563eb", color: "#fff",
            fontWeight: 600, cursor: running ? "default" : "pointer",
          }}
        >
          {running ? "Running..." : "Run"}
        </button>
      </div>

      <Pipeline events={events} />
      <TaskLog events={events} />
    </div>
  );
}
