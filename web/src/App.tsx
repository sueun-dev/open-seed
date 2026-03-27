import React, { useState, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import AGIMode from "./components/AGIMode";
import PairMode from "./components/PairMode";

export type Mode = "agi" | "pair";
export type Thread = { id: string; name: string; mode: Mode; project: string; updatedAt: string; events: any[] };

export default function App() {
  const [mode, setMode] = useState<Mode>("agi");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState("/tmp/openseed-output");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const activeThread = threads.find((t) => t.id === activeThreadId) || null;

  const createThread = (name: string, threadMode: Mode) => {
    const id = `thread-${Date.now()}`;
    const project = workingDir.split("/").pop() || "untitled";
    const thread: Thread = { id, name, mode: threadMode, project, updatedAt: new Date().toISOString(), events: [] };
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(id);
    setMode(threadMode);
    return id;
  };

  const updateThreadEvents = (threadId: string, events: any[]) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, events, updatedAt: new Date().toISOString() } : t))
    );
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0a0a0a", color: "#eee", fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
      {/* Sidebar */}
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSelectThread={(id) => {
          setActiveThreadId(id);
          const t = threads.find((th) => th.id === id);
          if (t) setMode(t.mode);
        }}
        onNewThread={() => setActiveThreadId(null)}
      />

      {/* Main Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Top Bar */}
        <div style={{
          height: 48, borderBottom: "1px solid #1a1a1a", display: "flex",
          alignItems: "center", justifyContent: "space-between", padding: "0 20px",
          background: "#0d0d0d", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Open Seed</span>
            <span style={{ fontSize: 11, color: "#444", fontWeight: 500 }}>v2</span>
          </div>

          {/* Mode Toggle */}
          <div style={{ display: "flex", gap: 2, background: "#111", borderRadius: 8, padding: 2 }}>
            {([
              { key: "agi" as Mode, label: "AGI Mode", icon: "🤖" },
              { key: "pair" as Mode, label: "Pair Mode", icon: "👥" },
            ]).map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                style={{
                  padding: "6px 16px", borderRadius: 6, border: "none",
                  background: mode === m.key ? "#1e3a5f" : "transparent",
                  color: mode === m.key ? "#60a5fa" : "#666",
                  fontWeight: 600, cursor: "pointer", fontSize: 12,
                  transition: "all 0.15s",
                }}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>

          {/* Right controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>
              {workingDir.length > 40 ? "..." + workingDir.slice(-37) : workingDir}
            </span>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {mode === "agi" ? (
            <AGIMode
              activeThread={activeThread}
              workingDir={workingDir}
              setWorkingDir={setWorkingDir}
              createThread={createThread}
              updateThreadEvents={updateThreadEvents}
            />
          ) : (
            <PairMode
              activeThread={activeThread}
              workingDir={workingDir}
              setWorkingDir={setWorkingDir}
              createThread={createThread}
              updateThreadEvents={updateThreadEvents}
            />
          )}
        </div>
      </div>
    </div>
  );
}
