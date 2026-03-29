import React, { useState } from "react";

type DiffEntry = {
  files_created: string[];
  files_modified: string[];
  summary: string;
};

type Props = {
  diffs: DiffEntry[];
  onClose: () => void;
  workingDir?: string;
};

export default function DiffPanel({ diffs, onClose, workingDir }: Props) {
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const totalCreated = diffs.reduce((acc, d) => acc + d.files_created.length, 0);
  const totalModified = diffs.reduce((acc, d) => acc + d.files_modified.length, 0);

  const doCommit = async () => {
    if (!commitMsg.trim() || !workingDir || committing) return;
    setCommitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
          working_dir: workingDir,
        }),
      });
      const data = await res.json();
      if (data.exit_code === 0) {
        setResult("Committed successfully");
        setShowCommitInput(false);
        setCommitMsg("");
      } else {
        setResult(`Error: ${data.output?.slice(0, 200) || "commit failed"}`);
      }
    } catch (err) {
      setResult(`Error: ${err}`);
    } finally {
      setCommitting(false);
    }
  };

  const doRevert = async () => {
    if (!workingDir || !confirm("Revert all uncommitted changes? This cannot be undone.")) return;
    setResult(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "git checkout -- . && git clean -fd",
          working_dir: workingDir,
        }),
      });
      const data = await res.json();
      if (data.exit_code === 0) {
        setResult("Reverted all changes");
      } else {
        setResult(`Error: ${data.output?.slice(0, 200) || "revert failed"}`);
      }
    } catch (err) {
      setResult(`Error: ${err}`);
    }
  };

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
          aria-label="Close diff panel"
          style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, transition: "color 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.color = "#aaa"}
          onMouseLeave={(e) => e.currentTarget.style.color = "#555"}
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
                <span style={{ fontSize: 12, color: "#ccc", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f}>
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
                <span style={{ fontSize: 12, color: "#ccc", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f}>
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

      {/* Result message */}
      {result && (
        <div style={{
          padding: "8px 16px", fontSize: 11,
          color: result.startsWith("Error") ? "#f87171" : "#4ade80",
          background: result.startsWith("Error") ? "#1a1212" : "#0d1a0d",
        }}>
          {result}
        </div>
      )}

      {/* Commit message input */}
      {showCommitInput && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid #1a1a1a" }}>
          <input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && commitMsg.trim()) {
                doCommit();
              } else if (e.key === "Escape") {
                setShowCommitInput(false);
              }
            }}
            placeholder="Commit message..."
            autoFocus
            style={{
              width: "100%", padding: "6px 10px", borderRadius: 6,
              border: "1px solid #333", background: "#111", color: "#eee",
              fontSize: 12, outline: "none",
            }}
            onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
            onBlur={(e) => e.currentTarget.style.borderColor = "#333"}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={() => setShowCommitInput(false)}
              style={{
                flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #333",
                background: "transparent", color: "#888", cursor: "pointer", fontSize: 11,
              }}
            >
              Cancel
            </button>
            <button
              onClick={doCommit}
              disabled={!commitMsg.trim() || committing}
              style={{
                flex: 1, padding: "6px", borderRadius: 6, border: "none",
                background: commitMsg.trim() ? "#2563eb" : "#222",
                color: commitMsg.trim() ? "#fff" : "#555",
                cursor: commitMsg.trim() ? "pointer" : "default", fontSize: 11, fontWeight: 600,
              }}
            >
              {committing ? "..." : "Commit"}
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {(totalCreated > 0 || totalModified > 0) && !showCommitInput && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a", display: "flex", gap: 8 }}>
          <button
            onClick={doRevert}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 8,
              border: "1px solid #333", background: "#111",
              color: "#888", cursor: "pointer", fontSize: 12, fontWeight: 600,
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#f87171"; e.currentTarget.style.color = "#f87171"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#333"; e.currentTarget.style.color = "#888"; }}
          >
            Revert All
          </button>
          <button
            onClick={() => setShowCommitInput(true)}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 8,
              border: "none", background: "#2563eb",
              color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600,
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "#3b82f6"}
            onMouseLeave={(e) => e.currentTarget.style.background = "#2563eb"}
          >
            Commit
          </button>
        </div>
      )}
    </div>
  );
}
