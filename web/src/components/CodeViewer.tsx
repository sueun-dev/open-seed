import React, { useState, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";

type Props = {
  workingDir: string;
  highlightFiles?: string[];
  onOpenFilesChange?: (openFiles: string[], activeFile: string | null) => void;
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
  dirty: boolean;
};

// Map file extensions to Monaco language IDs
function getLanguage(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    css: "css", scss: "scss", html: "html", json: "json", md: "markdown",
    yaml: "yaml", yml: "yaml", toml: "ini", sql: "sql", sh: "shell",
    bash: "shell", zsh: "shell", graphql: "graphql", vue: "html",
    svelte: "html", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}

export default function CodeViewer({ workingDir, highlightFiles = [], onOpenFilesChange }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Report open files to parent
  useEffect(() => {
    if (onOpenFilesChange) {
      const files = openTabs.map((t) => t.path.replace(workingDir + "/", ""));
      const active = activeTab ? activeTab.replace(workingDir + "/", "") : null;
      onOpenFilesChange(files, active);
    }
  }, [openTabs.length, activeTab]);

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

  const openFile = async (path: string, name: string) => {
    const existing = openTabs.find((t) => t.path === path);
    if (existing) { setActiveTab(path); return; }

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setOpenTabs((prev) => [...prev, { path, name, content: data.content || "", dirty: false }]);
        setActiveTab(path);
      }
    } catch {}
  };

  const closeTab = (path: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.dirty && !confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;
    setOpenTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTab === path) {
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

  // Save file (Ctrl+S)
  const saveFile = useCallback(async (path: string) => {
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return;
    setSaving(true);
    try {
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tab.path, content: tab.content }),
      });
      if (res.ok) {
        setOpenTabs((prev) => prev.map((t) => t.path === path ? { ...t, dirty: false } : t));
      }
    } catch {} finally {
      setSaving(false);
    }
  }, [openTabs]);

  // Handle editor content change
  const onEditorChange = (value: string | undefined, path: string) => {
    if (value === undefined) return;
    setOpenTabs((prev) => prev.map((t) => t.path === path ? { ...t, content: value, dirty: true } : t));
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
      openTabs.forEach(async (tab) => {
        if (highlightFiles.some((f) => tab.path.endsWith(f) || f.endsWith(tab.name))) {
          if (tab.dirty) return; // Don't overwrite unsaved changes
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
              display: "flex", alignItems: "center", gap: 4, transition: "background 0.1s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "#1a1a1a"}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <span style={{ fontSize: 10, color: "#555", width: 12 }}>{isExpanded ? "▼" : "▶"}</span>
            <span>{node.name}</span>
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
          fontWeight: openTabs.some((t) => t.path === node.path) ? 600 : 400,
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
    <div style={{ display: "flex", height: "100%", background: "#1e1e1e" }}>
      {/* File tree */}
      <div style={{
        width: 200, borderRight: "1px solid #1a1a1a", overflowY: "auto",
        padding: "8px 0", flexShrink: 0, background: "#0d0d0d",
      }}>
        <div style={{ padding: "4px 12px 8px", fontSize: 11, color: "#555", fontWeight: 600 }}>FILES</div>
        {tree.length === 0 && <div style={{ padding: "12px", color: "#444", fontSize: 11 }}>No files</div>}
        {tree.map((node) => renderNode(node))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Tab bar */}
        {openTabs.length > 0 && (
          <div style={{
            height: 36, borderBottom: "1px solid #1a1a1a", display: "flex",
            alignItems: "center", overflowX: "auto", flexShrink: 0, background: "#0d0d0d",
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
                    background: isActive ? "#1e1e1e" : "transparent",
                    borderRight: "1px solid #111",
                    borderBottom: isActive ? "2px solid #2563eb" : "2px solid transparent",
                    flexShrink: 0, transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#111"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  {tab.dirty ? (
                    <span style={{ fontSize: 8, color: "#facc15" }}>●</span>
                  ) : isModified ? (
                    <span style={{ fontSize: 8, color: "#4ade80" }}>●</span>
                  ) : null}
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
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = "#fff"}
                    onMouseLeave={(e) => e.currentTarget.style.color = "#555"}
                  >
                    x
                  </button>
                </div>
              );
            })}
            {saving && <span style={{ fontSize: 10, color: "#555", padding: "0 8px" }}>Saving...</span>}
          </div>
        )}

        {/* Monaco Editor */}
        <div style={{ flex: 1 }}>
          {!activeContent ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ textAlign: "center", color: "#444", fontSize: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                Select a file to view
              </div>
            </div>
          ) : (
            <Editor
              key={activeContent.path}
              language={getLanguage(activeContent.name)}
              value={activeContent.content}
              theme="vs-dark"
              onChange={(value) => onEditorChange(value, activeContent.path)}
              onMount={(editor) => {
                // Ctrl+S / Cmd+S to save
                editor.addCommand(
                  // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.KeyS
                  2048 | 49, // CtrlCmd + S
                  () => saveFile(activeContent.path),
                );
              }}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: "off",
                tabSize: 2,
                lineNumbers: "on",
                renderWhitespace: "selection",
                bracketPairColorization: { enabled: true },
                smoothScrolling: true,
                cursorSmoothCaretAnimation: "on",
                padding: { top: 8 },
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
