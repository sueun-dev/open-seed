import React, { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import AGIMode from "./components/AGIMode";
import PairMode from "./components/PairMode";
import FolderBrowser from "./components/FolderBrowser";

export type Mode = "agi" | "pair";
export type Project = { path: string; name: string };
export type Thread = { id: string; name: string; mode: Mode; projectPath: string; updatedAt: string; events: any[] };

// Persist to localStorage
function loadState<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveState(key: string, value: any) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default function App() {
  const [mode, setMode] = useState<Mode>(() => loadState("os_mode", "agi"));
  const [projects, setProjects] = useState<Project[]>(() => loadState("os_projects", []));
  const [activeProjectPath, setActiveProjectPath] = useState<string>(() => loadState("os_activeProject", ""));
  const [threads, setThreads] = useState<Thread[]>(() => loadState("os_threads", []));
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => loadState("os_activeThread", null));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadState("os_collapsed", false));
  const [showBrowser, setShowBrowser] = useState(false);
  const [dropHighlight, setDropHighlight] = useState(false);

  // Auto-save to localStorage on change
  useEffect(() => { saveState("os_mode", mode); }, [mode]);
  useEffect(() => { saveState("os_projects", projects); }, [projects]);
  useEffect(() => { saveState("os_activeProject", activeProjectPath); }, [activeProjectPath]);
  useEffect(() => { saveState("os_threads", threads); }, [threads]);
  useEffect(() => { saveState("os_activeThread", activeThreadId); }, [activeThreadId]);
  useEffect(() => { saveState("os_collapsed", sidebarCollapsed); }, [sidebarCollapsed]);

  const activeThread = threads.find((t) => t.id === activeThreadId) || null;
  const activeProject = projects.find((p) => p.path === activeProjectPath) || null;

  // Add a project (folder) if not already registered
  const addProject = (path: string) => {
    const name = path.split("/").filter(Boolean).pop() || "untitled";
    setProjects((prev) => {
      if (prev.some((p) => p.path === path)) return prev;
      return [...prev, { path, name }];
    });
    setActiveProjectPath(path);
  };

  // Create a new thread under current project
  const createThread = (name: string, threadMode: Mode) => {
    if (!activeProjectPath) return "";
    const id = `thread-${Date.now()}`;
    const thread: Thread = {
      id, name, mode: threadMode,
      projectPath: activeProjectPath,
      updatedAt: new Date().toISOString(),
      events: [],
    };
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(id);
    setMode(threadMode);
    return id;
  };

  // New thread = clear active, show start screen
  const handleNewThread = () => {
    setActiveThreadId(null);
  };

  // Remove a project and its threads
  const removeProject = (path: string) => {
    setProjects((prev) => prev.filter((p) => p.path !== path));
    setThreads((prev) => prev.filter((t) => t.projectPath !== path));
    if (activeProjectPath === path) {
      setActiveProjectPath("");
      setActiveThreadId(null);
    }
  };

  // Delete a single thread
  const deleteThread = (threadId: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
    }
  };

  const updateThreadEvents = (threadId: string, events: any[]) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, events, updatedAt: new Date().toISOString() } : t))
    );
  };

  // Resolve dropped folder to absolute path, then add as project
  const resolveAndAddFolder = async (folderName: string, childNames?: string[]) => {
    let resolved = "";

    // 1. Already absolute path → use directly
    if (folderName.startsWith("/")) {
      resolved = folderName;
    } else {
      // 2. Just a name → try to resolve via backend (with children for disambiguation)
      try {
        const params = new URLSearchParams({ name: folderName });
        if (childNames && childNames.length > 0) {
          params.set("children", childNames.join(","));
        }
        const res = await fetch(`/api/resolve-folder?${params}`);
        if (res.ok) {
          const text = await res.text();
          if (text) {
            const data = JSON.parse(text);
            if (data.matches?.length >= 1) {
              resolved = data.matches[0];
            }
          }
        }
      } catch {}
      if (!resolved) resolved = "/" + folderName;
    }

    addProject(resolved);
    setActiveThreadId(null);
  };

  // Read top-level children from a dropped directory entry
  const readDirChildren = (dirEntry: any): Promise<string[]> => {
    return new Promise((resolve) => {
      if (!dirEntry?.isDirectory) { resolve([]); return; }
      const reader = dirEntry.createReader();
      reader.readEntries(
        (entries: any[]) => resolve(entries.map((e: any) => e.name).sort()),
        () => resolve([]),
      );
    });
  };

  // Global drag & drop — extract absolute path first, name as fallback
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHighlight(false);

    let folderPath = "";
    let childNames: string[] = [];

    // 1. Try to get absolute path from file (Electron/native apps set .path)
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const fp = (files[0] as any).path;
      if (fp && fp.startsWith("/")) { folderPath = fp; }
    }

    // 2. Try text/plain (some file managers drop absolute paths as text)
    if (!folderPath) {
      const text = e.dataTransfer.getData("text/plain")?.trim();
      if (text && text.startsWith("/")) { folderPath = text; }
    }

    // 3. Fallback: webkitGetAsEntry for directory name + read children for disambiguation
    if (!folderPath) {
      const items = e.dataTransfer.items;
      if (items?.length) {
        for (let i = 0; i < items.length; i++) {
          const entry = (items[i] as any).webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            folderPath = entry.name;
            childNames = await readDirChildren(entry);
            break;
          }
        }
      }
    }

    // 4. Last fallback: file name
    if (!folderPath && files.length > 0) {
      folderPath = files[0].name;
    }

    if (folderPath) await resolveAndAddFolder(folderPath, childNames);
  };

  // No project selected — show onboarding
  const showOnboarding = !activeProjectPath;

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
            <div style={{ fontSize: 16, fontWeight: 700, color: "#60a5fa" }}>Drop folder to add project</div>
            <div style={{ fontSize: 12, color: "#446", marginTop: 4 }}>Each folder becomes a project workspace</div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <Sidebar
        projects={projects}
        activeProjectPath={activeProjectPath}
        threads={threads}
        activeThreadId={activeThreadId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSelectProject={(path) => { setActiveProjectPath(path); setActiveThreadId(null); }}
        onSelectThread={(id) => {
          setActiveThreadId(id);
          const t = threads.find((th) => th.id === id);
          if (t) { setMode(t.mode); setActiveProjectPath(t.projectPath); }
        }}
        onNewThread={handleNewThread}
        onAddProject={() => setShowBrowser(true)}
        onRemoveProject={removeProject}
        onDeleteThread={deleteThread}
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

          {/* Mode Toggle — only show when project is selected */}
          {activeProjectPath && (
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
          )}

          {/* Current project */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {activeProject ? (
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
                title={activeProject.path}
              >
                <span style={{ fontSize: 12 }}>📁</span>
                <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeProject.name}
                </span>
              </button>
            ) : (
              <span style={{ fontSize: 11, color: "#444" }}>No project selected</span>
            )}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {showOnboarding ? (
            /* Onboarding — no project yet */
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
              <div style={{ fontSize: 56, marginBottom: 8 }}>📁</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: 0 }}>Drop a folder to start</h2>
              <p style={{ color: "#555", fontSize: 13, maxWidth: 400, textAlign: "center", lineHeight: 1.6 }}>
                Drag a project folder here, or click the button below to browse.
                Each folder becomes a workspace. All tasks run inside it.
              </p>
              <button
                onClick={() => setShowBrowser(true)}
                style={{
                  padding: "10px 24px", borderRadius: 10, border: "1px solid #333",
                  background: "#111", color: "#888", cursor: "pointer", fontSize: 13,
                  fontWeight: 600, transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = "#2563eb"}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = "#333"}
              >
                📁 Browse for folder
              </button>
            </div>
          ) : mode === "agi" ? (
            <AGIMode
              activeThread={activeThread}
              workingDir={activeProjectPath}
              setWorkingDir={(dir) => addProject(dir)}
              createThread={createThread}
              updateThreadEvents={updateThreadEvents}
            />
          ) : (
            <PairMode
              activeThread={activeThread}
              workingDir={activeProjectPath}
              setWorkingDir={(dir) => addProject(dir)}
              createThread={createThread}
              updateThreadEvents={updateThreadEvents}
            />
          )}
        </div>
      </div>

      {/* Folder Browser Modal */}
      {showBrowser && (
        <FolderBrowser
          onSelect={(path) => { addProject(path); setShowBrowser(false); }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}
