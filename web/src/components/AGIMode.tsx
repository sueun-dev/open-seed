import React, { useState, useRef, useEffect } from "react";
import Pipeline from "./Pipeline";
import TaskLog from "./TaskLog";
import type { Thread, Mode } from "../App";

type Props = {
  activeThread: Thread | null;
  workingDir: string;
  setWorkingDir: (dir: string) => void;
  createThread: (name: string, mode: Mode) => string;
  updateThreadEvents: (threadId: string, events: any[]) => void;
};

export default function AGIMode({ activeThread, workingDir, setWorkingDir, createThread, updateThreadEvents }: Props) {
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>(activeThread?.events || []);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");
  const threadIdRef = useRef<string | null>(activeThread?.id || null);

  useEffect(() => {
    if (activeThread) {
      setEvents(activeThread.events);
      threadIdRef.current = activeThread.id;
    }
  }, [activeThread?.id]);

  const startRun = async () => {
    if (!task.trim() || running) return;
    setRunning(true);
    setEvents([]);

    const tid = createThread(task.slice(0, 60), "agi");
    threadIdRef.current = tid;

    try {
      const ws = new WebSocket(`ws://${location.host}/ws/events`);
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          setEvents((prev) => {
            const next = [...prev, event];
            updateThreadEvents(tid, next);
            return next;
          });
          if (event.type === "pipeline.complete" || event.type === "pipeline.fail") {
            setRunning(false);
            setTimeout(() => ws.close(), 1000);
          }
        } catch {}
      };
      ws.onerror = () => setRunning(false);
      ws.onclose = () => setRunning(false);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        setTimeout(resolve, 1000);
      });

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

  // Empty state — no active thread
  if (!activeThread && events.length === 0 && !running) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>AGI Mode</h2>
          <p style={{ color: "#555", fontSize: 13, maxWidth: 400 }}>
            Describe what to build. The pipeline runs autonomously —
            intake, plan, implement, QA, fix, deploy, memorize.
          </p>
        </div>

        {/* Provider selector */}
        <div style={{ display: "flex", gap: 6 }}>
          {(["claude", "codex", "both"] as const).map((p) => (
            <button key={p} onClick={() => setProvider(p)} style={{
              padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: provider === p ? "1px solid #2563eb" : "1px solid #222",
              background: provider === p ? "#1e3a5f" : "#111",
              color: provider === p ? "#60a5fa" : "#666",
              transition: "all 0.15s",
            }}>
              {p === "claude" ? "🟣 Claude" : p === "codex" ? "🟢 Codex" : "⚡ Both"}
            </button>
          ))}
        </div>

        {/* Suggested tasks */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 600 }}>
          {[
            { icon: "🔨", text: "Build a REST API with auth and CRUD" },
            { icon: "🌐", text: "Create a React dashboard with charts" },
            { icon: "🐛", text: "Fix the login bug in auth.ts" },
          ].map((s) => (
            <button
              key={s.text}
              onClick={() => { setTask(s.text); }}
              style={{
                padding: "12px 16px", borderRadius: 10, border: "1px solid #222",
                background: "#111", color: "#999", cursor: "pointer", fontSize: 12,
                textAlign: "left", maxWidth: 200, transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#222"}
            >
              <span style={{ fontSize: 18, display: "block", marginBottom: 6 }}>{s.icon}</span>
              {s.text}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ width: "100%", maxWidth: 600, padding: "0 24px" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startRun()}
              placeholder="Describe what to build..."
              style={{
                flex: 1, padding: "12px 16px", borderRadius: 10,
                border: "1px solid #222", background: "#111", color: "#eee",
                fontSize: 14, outline: "none",
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
              onBlur={(e) => e.currentTarget.style.borderColor = "#222"}
            />
            <button
              onClick={startRun}
              disabled={!task.trim()}
              style={{
                padding: "12px 20px", borderRadius: 10, border: "none",
                background: task.trim() ? "#2563eb" : "#222",
                color: task.trim() ? "#fff" : "#555",
                fontWeight: 700, cursor: task.trim() ? "pointer" : "default",
                fontSize: 14, transition: "background 0.15s",
              }}
            >
              Run →
            </button>
          </div>
          <div style={{
            display: "flex", gap: 8, marginTop: 8, alignItems: "center",
          }}>
            <span style={{ fontSize: 11, color: "#444" }}>📁</span>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              style={{
                flex: 1, padding: "4px 8px", borderRadius: 6,
                border: "none", background: "transparent", color: "#555",
                fontSize: 11, outline: "none", fontFamily: "monospace",
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Running / completed state
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 24px", overflow: "hidden" }}>
      {/* Pipeline progress */}
      <Pipeline events={events} />

      {/* Status badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {running ? (
          <span style={{ fontSize: 12, color: "#60a5fa", fontWeight: 600 }}>⠋ Pipeline running...</span>
        ) : events.some((e) => e.type === "pipeline.complete") ? (
          <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>✓ Pipeline complete</span>
        ) : events.some((e) => e.type === "pipeline.fail") ? (
          <span style={{ fontSize: 12, color: "#f87171", fontWeight: 600 }}>✗ Pipeline failed</span>
        ) : null}
        <span style={{ fontSize: 11, color: "#444" }}>{events.length} events</span>
      </div>

      {/* Event log */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <TaskLog events={events} />
      </div>

      {/* Input for follow-up */}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && startRun()}
          placeholder={running ? "Pipeline is running..." : "Run another task..."}
          disabled={running}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: "1px solid #222", background: "#0d0d0d", color: "#eee",
            fontSize: 13, outline: "none",
          }}
        />
        <button
          onClick={startRun}
          disabled={running || !task.trim()}
          style={{
            padding: "10px 18px", borderRadius: 10, border: "none",
            background: running ? "#222" : "#2563eb", color: running ? "#555" : "#fff",
            fontWeight: 700, cursor: running ? "default" : "pointer", fontSize: 13,
          }}
        >
          {running ? "Running..." : "Run →"}
        </button>
      </div>
    </div>
  );
}
