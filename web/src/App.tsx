import React, { useState, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import AGIMode from "./components/AGIMode";
import PairMode from "./components/PairMode";
import FolderBrowser from "./components/FolderBrowser";

export type Mode = "agi" | "pair";
export type Thread = { id: string; name: string; mode: Mode; project: string; updatedAt: string; events: any[] };

export default function App() {
  const [mode, setMode] = useState<Mode>("agi");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState("/tmp/openseed-output");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [dropHighlight, setDropHighlight] = useState(false);

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

  // Resolve dropped folder name to absolute path
  const resolveFolder = async (folderName: string) => {
    if (folderName.startsWith("/")) {
      setWorkingDir(folderName);
      return;
    }
    try {
      const res = await fetch(`/api/resolve-folder?name=${encodeURIComponent(folderName)}`);
      const data = await res.json();
      if (data.matches?.length === 1) {
        setWorkingDir(data.matches[0]);
      } else if (data.matches?.length > 1) {
        const choice = window.prompt(
          `Multiple folders found:\n\n${data.matches.map((m: string, i: number) => `${i + 1}. ${m}`).join("\n")}\n\nEnter number:`,
          "1"
        );
        const idx = parseInt(choice || "1", 10) - 1;
        if (idx >= 0 && idx < data.matches.length) setWorkingDir(data.matches[idx]);
      } else {
        setWorkingDir("/" + folderName);
      }
    } catch {
      setWorkingDir("/" + folderName);
    }
  };

  // Global drag & drop handler for folder
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHighlight(false);

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
    if (folderName) await resolveFolder(folderName);
  };

  return (
    <div
      style={{ display: "flex", height: "100vh", background: "#0a0a0a", color: "#eee", fontFamily: "'Inter', system-ui, -apple-system, sans-serif", position: "relative" }}
      onDragOver={(e) => { e.preventDefault(); setDropHighlight(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHighlight(false); }}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dropHighlight && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 100,
          background: "rgba(37, 99, 235, 0.08)", border: "3px dashed #2563eb",
          borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{
            padding: "24px 40px", borderRadius: 16, background: "#0c1a2e",
            border: "1px solid #2563eb", textAlign: "center",
          }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📁</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#60a5fa" }}>Drop folder here</div>
            <div style={{ fontSize: 12, color: "#446", marginTop: 4 }}>Sets working directory for all tasks</div>
          </div>
        </div>
      )}

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

          {/* Working directory (click to browse, shows path) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setShowBrowser(true)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 10px", borderRadius: 6, border: "1px solid #222",
                background: "#111", cursor: "pointer", maxWidth: 280,
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#222"}
              title={workingDir}
            >
              <span style={{ fontSize: 12 }}>📁</span>
              <span style={{
                fontSize: 11, color: "#888", fontFamily: "monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {workingDir.split("/").pop() || workingDir}
              </span>
              <span style={{ fontSize: 9, color: "#444" }}>▾</span>
            </button>
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

      {/* Folder Browser Modal */}
      {showBrowser && (
        <FolderBrowser
          onSelect={(path) => setWorkingDir(path)}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}
