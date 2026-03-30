import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrailleSpinner } from "./Spinner";
import mermaid from "mermaid";

type Props = {
  workingDir: string;
};

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    darkMode: true,
    background: "#0a0a0a",
    primaryColor: "#1e3a5f",
    primaryTextColor: "#e0e0e0",
    primaryBorderColor: "#2563eb",
    lineColor: "#444",
    secondaryColor: "#1a2e1a",
    tertiaryColor: "#1a1a2e",
    fontSize: "14px",
  },
  flowchart: {
    htmlLabels: true,
    curve: "basis",
    padding: 12,
  },
  securityLevel: "loose",
});

export default function DiagramMode({ workingDir }: Props) {
  const [diagram, setDiagram] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [filesScanned, setFilesScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [rendered, setRendered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<number | null>(null);

  // Fetch diagram (cached or trigger generation)
  const fetchDiagram = useCallback(async () => {
    if (!workingDir) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/diagram?working_dir=${encodeURIComponent(workingDir)}`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      if (data.status === "generating") {
        // Poll until ready
        if (!pollingRef.current) {
          pollingRef.current = window.setInterval(async () => {
            try {
              const r = await fetch(`/api/diagram?working_dir=${encodeURIComponent(workingDir)}`);
              const d = await r.json();
              if (d.status !== "generating") {
                if (pollingRef.current) clearInterval(pollingRef.current);
                pollingRef.current = null;
                if (d.mermaid) {
                  setDiagram(d.mermaid);
                  setShareUrl(d.share_url || "");
                  setFilesScanned(d.files_scanned || 0);
                } else {
                  setError(d.error || "Failed to generate diagram");
                }
                setLoading(false);
              }
            } catch {}
          }, 2000);
        }
        return;
      }

      if (data.mermaid) {
        setDiagram(data.mermaid);
        setShareUrl(data.share_url || "");
        setFilesScanned(data.files_scanned || 0);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  // Fetch on mount and workingDir change
  useEffect(() => {
    fetchDiagram();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [fetchDiagram]);

  // Listen for diagram.complete WebSocket events
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/events`);
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "diagram.complete") {
          fetchDiagram();
        }
      } catch {}
    };
    return () => ws.close();
  }, [fetchDiagram]);

  // Render mermaid when diagram changes
  useEffect(() => {
    if (!diagram || !containerRef.current) return;
    setRendered(false);

    const render = async () => {
      try {
        containerRef.current!.innerHTML = "";
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, diagram);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Make SVG fill container
          const svgEl = containerRef.current.querySelector("svg");
          if (svgEl) {
            svgEl.style.maxWidth = "100%";
            svgEl.style.height = "auto";
          }
          setRendered(true);
        }
      } catch (err) {
        if (containerRef.current) {
          containerRef.current.innerHTML = `<pre style="color:#f87171;font-size:12px;white-space:pre-wrap">Mermaid render error: ${String(err)}</pre>`;
        }
      }
    };
    render();
  }, [diagram]);

  // Regenerate
  const regenerate = async () => {
    setLoading(true);
    setError("");
    setDiagram("");
    setRendered(false);
    try {
      await fetch("/api/diagram/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_dir: workingDir }),
      });
      // Will get result via polling or WebSocket
      if (!pollingRef.current) {
        pollingRef.current = window.setInterval(async () => {
          try {
            const r = await fetch(`/api/diagram?working_dir=${encodeURIComponent(workingDir)}`);
            const d = await r.json();
            if (d.status !== "generating") {
              if (pollingRef.current) clearInterval(pollingRef.current);
              pollingRef.current = null;
              if (d.mermaid) {
                setDiagram(d.mermaid);
                setShareUrl(d.share_url || "");
                setFilesScanned(d.files_scanned || 0);
              } else {
                setError(d.error || "Failed to generate diagram");
              }
              setLoading(false);
            }
          } catch {}
        }, 2000);
      }
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  // Copy mermaid code
  const copyCode = () => {
    navigator.clipboard.writeText(diagram);
  };

  // Loading state
  if (loading && !diagram) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <div style={{ fontSize: 14, color: "#60a5fa", fontWeight: 600 }}>
          <BrailleSpinner /> Generating architecture diagram...
        </div>
        <p style={{ color: "#555", fontSize: 12 }}>
          Scanning codebase, analyzing architecture, creating Mermaid diagram
        </p>
      </div>
    );
  }

  // Empty state (no diagram yet, not loading)
  if (!diagram && !loading && !error) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#fff", margin: 0 }}>Diagram Mode</h2>
        <p style={{ color: "#555", fontSize: 13, maxWidth: 400, textAlign: "center" }}>
          Architecture diagrams are automatically generated after pipeline runs.
          You can also generate one manually.
        </p>
        <button
          onClick={regenerate}
          style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "#2563eb", color: "#fff", cursor: "pointer",
            fontSize: 13, fontWeight: 700, transition: "background 0.15s",
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "#3b82f6"}
          onMouseLeave={(e) => e.currentTarget.style.background = "#2563eb"}
        >
          Generate Diagram
        </button>
        <div style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>
          {workingDir}
        </div>
      </div>
    );
  }

  // Error state
  if (error && !diagram) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <div style={{ fontSize: 48 }}>⚠</div>
        <p style={{ color: "#f87171", fontSize: 13 }}>{error}</p>
        <button
          onClick={regenerate}
          style={{
            padding: "8px 20px", borderRadius: 8, border: "1px solid #333",
            background: "transparent", color: "#888", cursor: "pointer", fontSize: 12,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // Diagram view
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
        borderBottom: "1px solid #1a1a1a", flexShrink: 0,
      }}>
        <span style={{ fontSize: 14 }}>📊</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#ccc" }}>Architecture Diagram</span>
        <span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>
          {filesScanned} files scanned
        </span>
        <div style={{ flex: 1 }} />

        {loading && <span style={{ fontSize: 11, color: "#60a5fa" }}><BrailleSpinner /> Updating...</span>}

        <button
          onClick={copyCode}
          title="Copy Mermaid code"
          style={{
            padding: "4px 10px", borderRadius: 6, border: "1px solid #222",
            background: "#111", color: "#888", cursor: "pointer", fontSize: 11,
          }}
        >
          Copy Code
        </button>
        {shareUrl && (
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid #222",
              background: "#111", color: "#60a5fa", cursor: "pointer", fontSize: 11,
              textDecoration: "none",
            }}
          >
            Open in Mermaid Live
          </a>
        )}
        <button
          onClick={regenerate}
          disabled={loading}
          title="Regenerate diagram"
          style={{
            padding: "4px 10px", borderRadius: 6, border: "1px solid #222",
            background: "#111", color: loading ? "#444" : "#888", cursor: loading ? "default" : "pointer", fontSize: 11,
          }}
        >
          Regenerate
        </button>
      </div>

      {/* Diagram */}
      <div style={{
        flex: 1, overflow: "auto", padding: 24,
        display: "flex", justifyContent: "center", alignItems: "flex-start",
        background: "#0a0a0a",
      }}>
        <div
          ref={containerRef}
          style={{ maxWidth: "100%", minHeight: 200 }}
        />
      </div>
    </div>
  );
}
