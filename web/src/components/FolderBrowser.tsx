import React, { useState, useEffect } from "react";

type Props = {
  onSelect: (path: string) => void;
  onClose: () => void;
};

type DirEntry = { name: string; path: string };

export default function FolderBrowser({ onSelect, onClose }: Props) {
  const [current, setCurrent] = useState("");
  const [parent, setParent] = useState("");
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [serverAvailable, setServerAvailable] = useState(true);

  const browse = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error("Empty response");
      const data = JSON.parse(text);
      if (data.error) { setError(data.error); return; }
      setCurrent(data.current);
      setParent(data.parent);
      setDirs(data.dirs || []);
      setServerAvailable(true);
    } catch (e) {
      setServerAvailable(false);
      setError("Backend not running. Type a path manually or drag a folder onto the app.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { browse(""); }, []);

  const handleManualSubmit = () => {
    const path = manualPath.trim();
    if (path) {
      onSelect(path);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999,
    }} onClick={onClose}>
      <div style={{
        background: "#111", border: "1px solid #333", borderRadius: 12,
        width: 500, maxHeight: "70vh", display: "flex", flexDirection: "column",
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #222", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#eee" }}>Select Project Folder</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>

        {/* Manual path input — always available */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #1a1a1a", display: "flex", gap: 8 }}>
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
            placeholder="Type full path (e.g. /Users/me/projects/myapp)"
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 6,
              border: "1px solid #333", background: "#0d0d0d", color: "#eee",
              fontSize: 12, fontFamily: "monospace", outline: "none",
            }}
            onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
            onBlur={(e) => e.currentTarget.style.borderColor = "#333"}
            autoFocus
          />
          <button
            onClick={handleManualSubmit}
            disabled={!manualPath.trim()}
            style={{
              padding: "8px 14px", borderRadius: 6, border: "none",
              background: manualPath.trim() ? "#2563eb" : "#222",
              color: manualPath.trim() ? "#fff" : "#555",
              cursor: manualPath.trim() ? "pointer" : "default",
              fontSize: 12, fontWeight: 600,
            }}
          >
            Open
          </button>
        </div>

        {/* Browseable folder list — only when server is available */}
        {serverAvailable && (
          <>
            {/* Path bar */}
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #1a1a1a", display: "flex", gap: 6, alignItems: "center" }}>
              <button
                onClick={() => parent && browse(parent)}
                disabled={!parent}
                style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#888", cursor: parent ? "pointer" : "default", padding: "2px 8px", fontSize: 12 }}
              >← Up</button>
              <span style={{ color: "#666", fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {current}
              </span>
            </div>

            {/* Folder list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 0", minHeight: 120 }}>
              {loading && <div style={{ color: "#555", padding: 16, textAlign: "center" }}>Loading...</div>}
              {!loading && dirs.length === 0 && !error && (
                <div style={{ color: "#444", padding: 16, textAlign: "center", fontSize: 12 }}>No subfolders</div>
              )}
              {dirs.map((d) => (
                <div
                  key={d.path}
                  onClick={() => browse(d.path)}
                  style={{
                    padding: "8px 16px", cursor: "pointer", display: "flex", gap: 8, alignItems: "center",
                    fontSize: 13, color: "#ccc", borderBottom: "1px solid #1a1a1a",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#1a1a1a")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 16 }}>📁</span>
                  <span>{d.name}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Server unavailable message */}
        {!serverAvailable && (
          <div style={{ padding: "24px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 8 }}>
              Backend not running. Type a path above, or drag a folder onto the app.
            </div>
            <div style={{ fontSize: 10, color: "#444", fontFamily: "monospace" }}>
              Start backend: openseed serve --port 8000
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid #222", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#555", fontSize: 11, fontFamily: "monospace" }}>
            {current || manualPath || "No path selected"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{
              padding: "8px 16px", borderRadius: 6, border: "1px solid #333",
              background: "#111", color: "#888", cursor: "pointer", fontSize: 12,
            }}>Cancel</button>
            {serverAvailable && current && (
              <button onClick={() => onSelect(current)} style={{
                padding: "8px 16px", borderRadius: 6, border: "none",
                background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}>Select This Folder</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
