import React from "react";
import type { Thread } from "../App";

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
};

export default function Sidebar({ threads, activeThreadId, collapsed, onToggle, onSelectThread, onNewThread }: Props) {
  // Group threads by project
  const grouped: Record<string, Thread[]> = {};
  for (const t of threads) {
    (grouped[t.project] ??= []).push(t);
  }

  if (collapsed) {
    return (
      <div style={{
        width: 48, borderRight: "1px solid #1a1a1a", background: "#0d0d0d",
        display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 12,
      }}>
        <button onClick={onToggle} style={iconBtnStyle} title="Expand sidebar">☰</button>
        <button onClick={onNewThread} style={{ ...iconBtnStyle, marginTop: 8 }} title="New thread">+</button>
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
        <span style={{ fontSize: 13, fontWeight: 700, color: "#999" }}>Threads</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onNewThread} style={iconBtnStyle} title="New thread">+</button>
          <button onClick={onToggle} style={iconBtnStyle} title="Collapse">«</button>
        </div>
      </div>

      {/* New Thread button */}
      <div style={{ padding: "0 12px 12px" }}>
        <button
          onClick={onNewThread}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8,
            border: "1px dashed #333", background: "transparent",
            color: "#888", cursor: "pointer", fontSize: 12, textAlign: "left",
          }}
        >
          + New thread
        </button>
      </div>

      {/* Thread list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {Object.entries(grouped).map(([project, projectThreads]) => (
          <div key={project} style={{ marginBottom: 16 }}>
            <div style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, color: "#555", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              {project}
            </div>
            {projectThreads.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelectThread(t.id)}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  border: "none", textAlign: "left", cursor: "pointer",
                  background: t.id === activeThreadId ? "#1a1a2e" : "transparent",
                  color: t.id === activeThreadId ? "#60a5fa" : "#888",
                  fontSize: 12, marginBottom: 2, display: "flex", alignItems: "center", gap: 8,
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (t.id !== activeThreadId) e.currentTarget.style.background = "#111"; }}
                onMouseLeave={(e) => { if (t.id !== activeThreadId) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontSize: 10 }}>{t.mode === "agi" ? "🤖" : "👥"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {t.name}
                </span>
                <span style={{ fontSize: 10, color: "#444", flexShrink: 0 }}>
                  {formatTime(t.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        ))}

        {threads.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: "#444", fontSize: 12 }}>
            No threads yet.<br />Start a new one above.
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a" }}>
        <div style={{ fontSize: 11, color: "#444" }}>Open Seed v2.0</div>
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
