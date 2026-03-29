import React, { useState, useEffect } from "react";

type Props = {
  workingDir: string;
  highlightFiles?: string[];
};

type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
};

export default function CodeViewer({ workingDir, highlightFiles = [] }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Load file tree
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(workingDir)}`);
        if (res.ok) {
          const data = await res.json();
          setTree(data.tree || []);
          // Auto-expand first level
          const firstLevel = new Set((data.tree || []).filter((n: FileNode) => n.isDir).map((n: FileNode) => n.path));
          setExpandedDirs(firstLevel);
        }
      } catch {}
    })();
  }, [workingDir]);

  // Load file content
  const openFile = async (path: string) => {
    setSelectedFile(path);
    setLoading(true);
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content || "");
      }
    } catch {
      setFileContent("Failed to load file");
    } finally {
      setLoading(false);
    }
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Refresh on highlight changes (new files modified)
  useEffect(() => {
    if (highlightFiles.length > 0) {
      // Reload tree to show new files
      (async () => {
        try {
          const res = await fetch(`/api/files?path=${encodeURIComponent(workingDir)}`);
          if (res.ok) {
            const data = await res.json();
            setTree(data.tree || []);
          }
        } catch {}
      })();
      // If a highlighted file is open, reload its content
      if (selectedFile && highlightFiles.includes(selectedFile)) {
        openFile(selectedFile);
      }
    }
  }, [highlightFiles.join(",")]);

  const renderNode = (node: FileNode, depth: number = 0): React.ReactNode => {
    const isHighlighted = highlightFiles.some((f) => node.path.endsWith(f) || f.endsWith(node.name));
    const isSelected = selectedFile === node.path;
    const isExpanded = expandedDirs.has(node.path);

    if (node.isDir) {
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            style={{
              width: "100%", padding: "4px 8px", paddingLeft: 8 + depth * 14,
              border: "none", background: "transparent", color: "#888",
              cursor: "pointer", fontSize: 12, textAlign: "left",
              display: "flex", alignItems: "center", gap: 4,
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "#1a1a1a"}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <span style={{ fontSize: 10, color: "#555", width: 12 }}>{isExpanded ? "▼" : "▶"}</span>
            <span style={{ color: "#888" }}>{node.name}</span>
          </button>
          {isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return (
      <button
        key={node.path}
        onClick={() => openFile(node.path)}
        style={{
          width: "100%", padding: "4px 8px", paddingLeft: 20 + depth * 14,
          border: "none", textAlign: "left", cursor: "pointer",
          background: isSelected ? "#1e3a5f" : isHighlighted ? "#1a2e1a" : "transparent",
          color: isSelected ? "#60a5fa" : isHighlighted ? "#4ade80" : "#999",
          fontSize: 12, display: "flex", alignItems: "center", gap: 4,
          transition: "background 0.1s",
          fontWeight: isHighlighted ? 600 : 400,
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#1a1a1a"; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = isHighlighted ? "#1a2e1a" : "transparent"; }}
      >
        {isHighlighted && <span style={{ fontSize: 8, color: "#4ade80" }}>●</span>}
        {node.name}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", height: "100%", background: "#0d0d0d" }}>
      {/* File tree */}
      <div style={{
        width: 200, borderRight: "1px solid #1a1a1a", overflowY: "auto",
        padding: "8px 0", flexShrink: 0,
      }}>
        <div style={{ padding: "4px 12px 8px", fontSize: 11, color: "#555", fontWeight: 600 }}>
          FILES
        </div>
        {tree.length === 0 && (
          <div style={{ padding: "12px", color: "#444", fontSize: 11 }}>No files</div>
        )}
        {tree.map((node) => renderNode(node))}
      </div>

      {/* File content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Tab bar */}
        {selectedFile && (
          <div style={{
            height: 36, borderBottom: "1px solid #1a1a1a", display: "flex",
            alignItems: "center", padding: "0 12px", gap: 8, flexShrink: 0,
          }}>
            <span style={{
              fontSize: 12, color: "#888", fontFamily: "monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {selectedFile.replace(workingDir + "/", "")}
            </span>
            <button
              onClick={() => { setSelectedFile(null); setFileContent(""); }}
              style={{
                marginLeft: "auto", background: "none", border: "none",
                color: "#555", cursor: "pointer", fontSize: 12,
              }}
            >
              x
            </button>
          </div>
        )}

        {/* Code */}
        <div style={{ flex: 1, overflowY: "auto", padding: selectedFile ? "0" : "40px 20px" }}>
          {!selectedFile ? (
            <div style={{ textAlign: "center", color: "#444", fontSize: 12 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
              Select a file to view
            </div>
          ) : loading ? (
            <div style={{ padding: 16, color: "#555", fontSize: 12 }}>Loading...</div>
          ) : (
            <pre style={{
              margin: 0, padding: "12px 16px", fontSize: 12, lineHeight: 1.6,
              color: "#ccc", fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              whiteSpace: "pre", overflowX: "auto", tabSize: 2,
            }}>
              {fileContent.split("\n").map((line, i) => (
                <div key={i} style={{ display: "flex" }}>
                  <span style={{
                    width: 40, flexShrink: 0, color: "#333", textAlign: "right",
                    paddingRight: 12, userSelect: "none",
                  }}>
                    {i + 1}
                  </span>
                  <span>{line}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
