import React from "react";

type DiffEntry = {
  files_created: string[];
  files_modified: string[];
  summary: string;
};

type Props = {
  diffs: DiffEntry[];
  onClose: () => void;
};

export default function DiffPanel({ diffs, onClose }: Props) {
  const totalCreated = diffs.reduce((acc, d) => acc + d.files_created.length, 0);
  const totalModified = diffs.reduce((acc, d) => acc + d.files_modified.length, 0);

  return (
    <div style={{
      width: 320, borderLeft: "1px solid #1a1a1a", background: "#0d0d0d",
      display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px", borderBottom: "1px solid #1a1a1a",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#eee" }}>Changes</span>
          <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>+{totalCreated}</span>
          <span style={{ fontSize: 11, color: "#60a5fa", fontWeight: 600 }}>~{totalModified}</span>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}
        >
          ✕
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {diffs.length === 0 && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#444", fontSize: 12 }}>
            No changes yet.
          </div>
        )}

        {diffs.map((d, i) => (
          <div key={i} style={{ padding: "8px 16px", borderBottom: "1px solid #111" }}>
            {d.files_created.map((f) => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: "#4ade80",
                  background: "#0d2818", padding: "1px 4px", borderRadius: 3,
                }}>
                  NEW
                </span>
                <span style={{ fontSize: 12, color: "#ccc", fontFamily: "monospace" }}>
                  {f}
                </span>
              </div>
            ))}
            {d.files_modified.map((f) => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: "#60a5fa",
                  background: "#0c1a2e", padding: "1px 4px", borderRadius: 3,
                }}>
                  MOD
                </span>
                <span style={{ fontSize: 12, color: "#ccc", fontFamily: "monospace" }}>
                  {f}
                </span>
              </div>
            ))}
            {d.summary && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 4, lineHeight: 1.4 }}>
                {d.summary.slice(0, 200)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      {(totalCreated > 0 || totalModified > 0) && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a", display: "flex", gap: 8 }}>
          <button style={{
            flex: 1, padding: "8px 12px", borderRadius: 8,
            border: "1px solid #333", background: "#111",
            color: "#888", cursor: "pointer", fontSize: 12, fontWeight: 600,
          }}>
            Revert All
          </button>
          <button style={{
            flex: 1, padding: "8px 12px", borderRadius: 8,
            border: "none", background: "#2563eb",
            color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600,
          }}>
            Commit
          </button>
        </div>
      )}
    </div>
  );
}
