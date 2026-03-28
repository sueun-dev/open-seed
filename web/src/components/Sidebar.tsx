import React, { useState } from "react";
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
  onRemoveProject: (path: string) => void;
  onDeleteThread: (id: string) => void;
};

export default function Sidebar({
  projects, activeProjectPath, threads, activeThreadId, collapsed,
  onToggle, onSelectProject, onSelectThread, onNewThread, onAddProject,
  onRemoveProject, onDeleteThread,
}: Props) {
  const w = collapsed ? 48 : 260;
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    type: "project" | "thread";
    id: string; // path for project, id for thread
  } | null>(null);

  const handleContextMenu = (
    e: React.MouseEvent,
    type: "project" | "thread",
    id: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type, id });
  };

  const closeMenu = () => setContextMenu(null);

  return (
    <div
      style={{
        width: w, minWidth: w, borderRight: "1px solid #1a1a1a", background: "#0d0d0d",
        display: "flex", flexDirection: "column", flexShrink: 0,
        transition: "width 0.2s ease, min-width 0.2s ease",
        overflow: "hidden",
      }}
      onClick={closeMenu}
    >
      {/* Collapsed icons */}
      {collapsed && (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: 12, gap: 6, opacity: collapsed ? 1 : 0,
          transition: "opacity 0.15s ease 0.1s",
        }}>
          <button onClick={onToggle} style={iconBtnStyle} title="Expand sidebar">☰</button>
          <button onClick={onNewThread} style={iconBtnStyle} title="New thread">+</button>
          <button onClick={onAddProject} style={iconBtnStyle} title="Add project">📁</button>
        </div>
      )}

      {/* Expanded content */}
      {!collapsed && (
        <div style={{
          display: "flex", flexDirection: "column", height: "100%",
          opacity: collapsed ? 0 : 1,
          transition: "opacity 0.15s ease 0.05s",
        }}>
          {/* Header */}
          <div style={{ padding: "14px 16px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#999", whiteSpace: "nowrap" }}>Projects</span>
            <button onClick={onToggle} style={iconBtnStyle} title="Collapse sidebar">«</button>
          </div>

          {/* Action buttons */}
          <div style={{ padding: "0 12px 8px", display: "flex", gap: 6 }}>
            <button onClick={onAddProject} style={actionBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#60a5fa"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#888"; }}
            >
              <span style={{ fontSize: 13 }}>+</span> Add Folder
            </button>
            <button onClick={onNewThread} style={actionBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#60a5fa"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#888"; }}
            >
              <span style={{ fontSize: 13 }}>+</span> New Thread
            </button>
          </div>

          {/* Project + Thread list */}
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 8px" }}>
            {projects.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center" }}>
                <div style={{ color: "#444", fontSize: 12, marginBottom: 12 }}>No projects yet.</div>
                <button onClick={onAddProject} style={{
                  padding: "8px 14px", borderRadius: 8, border: "1px dashed #333",
                  background: "transparent", color: "#666", cursor: "pointer", fontSize: 12,
                }}>
                  + Add folder
                </button>
              </div>
            )}

            {projects.map((project) => {
              const isActive = project.path === activeProjectPath;
              const projectThreads = threads.filter((t) => t.projectPath === project.path);

              return (
                <div key={project.path} style={{ marginBottom: 4 }}>
                  <button
                    onClick={() => onSelectProject(project.path)}
                    onContextMenu={(e) => handleContextMenu(e, "project", project.path)}
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
                      fontSize: 12, fontWeight: 600, color: isActive ? "#fff" : "#888",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
                    }}>
                      {project.name}
                    </span>
                    <span style={{ fontSize: 10, color: "#333" }}>{projectThreads.length || ""}</span>
                  </button>

                  {isActive && (
                    <div style={{ paddingLeft: 12, marginTop: 2 }}>
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

                      {projectThreads.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => onSelectThread(t.id)}
                          onContextMenu={(e) => handleContextMenu(e, "thread", t.id)}
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
                          <span style={{ fontSize: 9, color: "#333", flexShrink: 0 }}>{formatTime(t.updatedAt)}</span>
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
            <div style={{ fontSize: 11, color: "#444", whiteSpace: "nowrap" }}>Open Seed v2.0</div>
            <div style={{ fontSize: 10, color: "#333" }}>{projects.length} projects</div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.type === "project" ? [
            {
              label: "Remove Project",
              icon: "🗑",
              danger: true,
              onClick: () => { if (confirm("Remove this project and all its threads?")) onRemoveProject(contextMenu.id); closeMenu(); },
            },
          ] : [
            {
              label: "Delete Thread",
              icon: "🗑",
              danger: true,
              onClick: () => { if (confirm("Delete this thread?")) onDeleteThread(contextMenu.id); closeMenu(); },
            },
          ]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

// ── Context Menu Component ──────────────────────────────────────────────────

type MenuItem = {
  label: string;
  icon: string;
  danger?: boolean;
  onClick: () => void;
};

function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void;
}) {
  // Adjust position to stay within viewport
  const menuWidth = 180;
  const menuHeight = items.length * 36 + 8;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return (
    <>
      {/* Backdrop to capture clicks outside */}
      <div
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
      />
      <div style={{
        position: "fixed",
        left: adjustedX,
        top: adjustedY,
        zIndex: 1000,
        minWidth: menuWidth,
        background: "#1a1a1a",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "4px 0",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      }}>
        {items.map((item) => (
          <button
            key={item.label}
            onClick={item.onClick}
            style={{
              width: "100%",
              padding: "8px 14px",
              border: "none",
              background: "transparent",
              color: item.danger ? "#f87171" : "#ccc",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
              textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = item.danger ? "#2a1515" : "#222"}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <span style={{ fontSize: 12 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 6, border: "1px solid #333",
  background: "transparent", color: "#888", cursor: "pointer",
  fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
  transition: "all 0.15s",
};

const actionBtnStyle: React.CSSProperties = {
  flex: 1, padding: "7px 0", borderRadius: 7, border: "1px solid #222",
  background: "#111", color: "#888", cursor: "pointer", fontSize: 11,
  fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
  transition: "all 0.15s", whiteSpace: "nowrap",
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
