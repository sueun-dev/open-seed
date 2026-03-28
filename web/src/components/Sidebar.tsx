import React from "react";
import type { Thread, Project } from "../App";

type Props = {
  projects: Project[];
  activeProjectPath: string;
  threads: Thread[];
  activeThreadId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelectProject: (path: string) => void;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onAddProject: () => void;
};

export default function Sidebar({
  projects, activeProjectPath, threads, activeThreadId, collapsed,
  onToggle, onSelectProject, onSelectThread, onNewThread, onAddProject,
}: Props) {
  if (collapsed) {
    return (
      <div style={{
        width: 48, borderRight: "1px solid #1a1a1a", background: "#0d0d0d",
        display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 12, gap: 6,
      }}>
        <button onClick={onToggle} style={iconBtnStyle} title="Expand sidebar">☰</button>
        <button onClick={onNewThread} style={iconBtnStyle} title="New thread">+</button>
        <button onClick={onAddProject} style={iconBtnStyle} title="Add project">📁</button>
      </div>
    );
  }

  return (
    <div style={{
      width: 260, borderRight: "1px solid #1a1a1a", background: "#0d0d0d",
      display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{ padding: "14px 16px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#999" }}>Projects</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onToggle} style={iconBtnStyle} title="Collapse sidebar">«</button>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ padding: "0 12px 8px", display: "flex", gap: 6 }}>
        <button
          onClick={onAddProject}
          style={{
            flex: 1, padding: "7px 0", borderRadius: 7, border: "1px solid #222",
            background: "#111", color: "#888", cursor: "pointer", fontSize: 11,
            fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#60a5fa"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#888"; }}
        >
          <span style={{ fontSize: 13 }}>+</span> Add Folder
        </button>
        <button
          onClick={onNewThread}
          style={{
            flex: 1, padding: "7px 0", borderRadius: 7, border: "1px solid #222",
            background: "#111", color: "#888", cursor: "pointer", fontSize: 11,
            fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#60a5fa"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#888"; }}
        >
          <span style={{ fontSize: 13 }}>+</span> New Thread
        </button>
      </div>

      {/* Project + Thread list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {projects.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center" }}>
            <div style={{ color: "#444", fontSize: 12, marginBottom: 12 }}>
              No projects yet.
            </div>
            <button
              onClick={onAddProject}
              style={{
                padding: "8px 14px", borderRadius: 8, border: "1px dashed #333",
                background: "transparent", color: "#666", cursor: "pointer", fontSize: 12,
              }}
            >
              + Add folder
            </button>
          </div>
        )}

        {projects.map((project) => {
          const isActive = project.path === activeProjectPath;
          const projectThreads = threads.filter((t) => t.projectPath === project.path);

          return (
            <div key={project.path} style={{ marginBottom: 4 }}>
              {/* Project header */}
              <button
                onClick={() => onSelectProject(project.path)}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  border: "none", textAlign: "left", cursor: "pointer",
                  background: isActive ? "#111" : "transparent",
                  display: "flex", alignItems: "center", gap: 8,
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#0d0d0d"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                title={project.path}
              >
                <span style={{ fontSize: 12 }}>📁</span>
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  color: isActive ? "#fff" : "#888",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
                }}>
                  {project.name}
                </span>
                <span style={{ fontSize: 10, color: "#333" }}>{projectThreads.length || ""}</span>
              </button>

              {/* Threads under this project (only show when project is active) */}
              {isActive && (
                <div style={{ paddingLeft: 12, marginTop: 2 }}>
                  {/* New thread button */}
                  <button
                    onClick={onNewThread}
                    style={{
                      width: "100%", padding: "6px 8px", borderRadius: 6,
                      border: "1px dashed #222", background: "transparent",
                      color: "#555", cursor: "pointer", fontSize: 11, textAlign: "left",
                      marginBottom: 2, transition: "border-color 0.15s",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.borderColor = "#444"}
                    onMouseLeave={(e) => e.currentTarget.style.borderColor = "#222"}
                  >
                    + New thread
                  </button>

                  {/* Thread list */}
                  {projectThreads.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onSelectThread(t.id)}
                      style={{
                        width: "100%", padding: "6px 8px", borderRadius: 6,
                        border: "none", textAlign: "left", cursor: "pointer",
                        background: t.id === activeThreadId ? "#1a1a2e" : "transparent",
                        color: t.id === activeThreadId ? "#60a5fa" : "#666",
                        fontSize: 11, marginBottom: 1, display: "flex", alignItems: "center", gap: 6,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { if (t.id !== activeThreadId) e.currentTarget.style.background = "#111"; }}
                      onMouseLeave={(e) => { if (t.id !== activeThreadId) e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ fontSize: 9, flexShrink: 0 }}>{t.mode === "agi" ? "🤖" : "👥"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {t.name}
                      </span>
                      <span style={{ fontSize: 9, color: "#333", flexShrink: 0 }}>
                        {formatTime(t.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#444" }}>Open Seed v2.0</div>
        <div style={{ fontSize: 10, color: "#333" }}>{projects.length} projects</div>
      </div>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 6, border: "1px solid #333",
  background: "transparent", color: "#888", cursor: "pointer",
  fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}
