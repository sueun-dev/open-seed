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

type OpenTab = {
  path: string;
  name: string;
  content: string;
};

export default function CodeViewer({ workingDir, highlightFiles = [] }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
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
          const firstLevel = new Set((data.tree || []).filter((n: FileNode) => n.isDir).map((n: FileNode) => n.path));
          setExpandedDirs(firstLevel);
        }
      } catch {}
    })();
  }, [workingDir]);

  // Open a file in a new tab (or switch to existing)
  const openFile = async (path: string, name: string) => {
    // Already open? just switch
    const existing = openTabs.find((t) => t.path === path);
    if (existing) {
      setActiveTab(path);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setOpenTabs((prev) => [...prev, { path, name, content: data.content || "" }]);
        setActiveTab(path);
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const closeTab = (path: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setOpenTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTab === path) {
      // Switch to neighbor tab
      const idx = openTabs.findIndex((t) => t.path === path);
      const next = openTabs[idx + 1] || openTabs[idx - 1];
      setActiveTab(next?.path || null);
    }
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Refresh on highlight changes
  useEffect(() => {
    if (highlightFiles.length > 0) {
      (async () => {
        try {
          const res = await fetch(`/api/files?path=${encodeURIComponent(workingDir)}`);
          if (res.ok) setTree((await res.json()).tree || []);
        } catch {}
      })();
      // Reload open tabs that were modified
      openTabs.forEach(async (tab) => {
        if (highlightFiles.some((f) => tab.path.endsWith(f) || f.endsWith(tab.name))) {
          try {
            const res = await fetch(`/api/file?path=${encodeURIComponent(tab.path)}`);
            if (res.ok) {
              const data = await res.json();
              setOpenTabs((prev) => prev.map((t) => t.path === tab.path ? { ...t, content: data.content || "" } : t));
            }
          } catch {}
        }
      });
    }
  }, [highlightFiles.join(",")]);

  const activeContent = openTabs.find((t) => t.path === activeTab);

  const renderNode = (node: FileNode, depth: number = 0): React.ReactNode => {
    const isHighlighted = highlightFiles.some((f) => node.path.endsWith(f) || f.endsWith(node.name));
    const isOpen = openTabs.some((t) => t.path === node.path);
    const isActive = activeTab === node.path;
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
        onClick={() => openFile(node.path, node.name)}
        style={{
          width: "100%", padding: "4px 8px", paddingLeft: 20 + depth * 14,
          border: "none", textAlign: "left", cursor: "pointer",
          background: isActive ? "#1e3a5f" : isHighlighted ? "#1a2e1a" : "transparent",
          color: isActive ? "#60a5fa" : isHighlighted ? "#4ade80" : "#999",
          fontSize: 12, display: "flex", alignItems: "center", gap: 4,
          transition: "background 0.1s",
          fontWeight: isOpen ? 600 : 400,
        }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#1a1a1a"; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isHighlighted ? "#1a2e1a" : "transparent"; }}
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

      {/* File content area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Tab bar */}
        {openTabs.length > 0 && (
          <div style={{
            height: 36, borderBottom: "1px solid #1a1a1a", display: "flex",
            alignItems: "center", overflowX: "auto", flexShrink: 0,
          }}>
            {openTabs.map((tab) => {
              const isActive = tab.path === activeTab;
              const isModified = highlightFiles.some((f) => tab.path.endsWith(f) || f.endsWith(tab.name));
              return (
                <div
                  key={tab.path}
                  onClick={() => setActiveTab(tab.path)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "0 12px", height: "100%", cursor: "pointer",
                    background: isActive ? "#1a1a1a" : "transparent",
                    borderRight: "1px solid #111",
                    borderBottom: isActive ? "2px solid #2563eb" : "2px solid transparent",
                    transition: "background 0.1s",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#111"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  {isModified && <span style={{ fontSize: 8, color: "#4ade80" }}>●</span>}
                  <span style={{
                    fontSize: 12, color: isActive ? "#ddd" : "#888",
                    fontFamily: "monospace", whiteSpace: "nowrap",
                  }}>
                    {tab.name}
                  </span>
                  <button
                    onClick={(e) => closeTab(tab.path, e)}
                    style={{
                      background: "none", border: "none", color: "#555",
                      cursor: "pointer", fontSize: 10, padding: "0 2px",
                      transition: "color 0.1s",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = "#fff"}
                    onMouseLeave={(e) => e.currentTarget.style.color = "#555"}
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Code */}
        <div style={{ flex: 1, overflowY: "auto", padding: activeContent ? "0" : "40px 20px" }}>
          {!activeContent ? (
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
              {activeContent.content.split("\n").map((line, i) => (
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
