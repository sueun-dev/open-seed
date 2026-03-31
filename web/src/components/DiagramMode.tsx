import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrailleSpinner } from "./Spinner";

type Props = {
  workingDir: string;
};

let mermaidInitialized = false;

async function getMermaid() {
  const m = (await import("mermaid")).default;
  if (!mermaidInitialized) {
    m.initialize({
      startOnLoad: false,
      theme: "dark",
      themeVariables: {
        darkMode: true,
        background: "transparent",
        primaryColor: "#1e3a5f",
        primaryTextColor: "#e8e8e8",
        primaryBorderColor: "#3b82f6",
        lineColor: "#555",
        secondaryColor: "#1a2e1a",
        secondaryTextColor: "#d4d4d4",
        tertiaryColor: "#1a1a2e",
        tertiaryTextColor: "#d4d4d4",
        noteBkgColor: "#1a1a2e",
        noteTextColor: "#d4d4d4",
        fontSize: "15px",
        fontFamily: "'Inter', 'SF Pro', system-ui, sans-serif",
        edgeLabelBackground: "#111",
        clusterBkg: "#111118",
        clusterBorder: "#2a2a3a",
        titleColor: "#e8e8e8",
      },
      flowchart: { htmlLabels: true, curve: "basis", padding: 16, nodeSpacing: 40, rankSpacing: 60 },
      securityLevel: "loose",
    });
    mermaidInitialized = true;
  }
  return m;
}

export default function DiagramMode({ workingDir }: Props) {
  const [diagram, setDiagram] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [filesScanned, setFilesScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [rendered, setRendered] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [generator, setGenerator] = useState<"claude" | "gpt">("claude");
  const [verifier, setVerifier] = useState<"claude" | "gpt">("gpt");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<number | null>(null);

  // Fetch diagram (cached or trigger generation)
  // Check cache only (no auto-generation)
  const checkCache = useCallback(async () => {
    if (!workingDir) return;
    try {
      const res = await fetch(`/api/diagram?working_dir=${encodeURIComponent(workingDir)}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === "generating") {
        setLoading(true);
        startPolling();
        return;
      }
      if (data.mermaid) {
        setDiagram(data.mermaid);
        setShareUrl(data.share_url || "");
        setFilesScanned(data.files_scanned || 0);
      }
    } catch {}
  }, [workingDir]);

  // Poll for result
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
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
  }, [workingDir]);

  // On mount: only check cache (don't auto-generate)
  useEffect(() => {
    checkCache();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [checkCache]);

  // Listen for diagram events (progress + complete)
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/events`);
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "diagram.progress") {
          const msg = event.data?.message || "";
          if (msg) setProgressLog((prev) => [...prev, msg]);
        } else if (event.type === "diagram.complete") {
          checkCache();
        }
      } catch {}
    };
    return () => ws.close();
  }, [checkCache]);

  // Render mermaid when diagram changes
  useEffect(() => {
    if (!diagram || !containerRef.current) return;
    setRendered(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });

    const render = async () => {
      try {
        containerRef.current!.innerHTML = "";
        const id = `mermaid-${Date.now()}`;
        const m = await getMermaid();
        const { svg } = await m.render(id, diagram);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          const svgEl = containerRef.current.querySelector("svg");
          if (svgEl) {
            svgEl.style.width = "100%";
            svgEl.style.height = "100%";
            svgEl.style.minWidth = "800px";
            svgEl.style.minHeight = "500px";
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

  // Mouse wheel zoom — attached via onWheel React prop instead of addEventListener
  // (React onWheel is always non-passive, so preventDefault works)

  // Drag to pan
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Generate (or regenerate)
  const generate = async () => {
    setLoading(true);
    setError("");
    setDiagram("");
    setRendered(false);
    setProgressLog([]);
    try {
      await fetch("/api/diagram/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_dir: workingDir, generator, verifier }),
      });
      startPolling();
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  // Copy mermaid code
  const copyCode = () => {
    navigator.clipboard.writeText(diagram);
  };

  // No folder selected
  if (!workingDir) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#fff", margin: 0 }}>Diagram Mode</h2>
        <p style={{ color: "#555", fontSize: 13, maxWidth: 400, textAlign: "center" }}>
          Select a project folder first, then generate an architecture diagram.
        </p>
      </div>
    );
  }

  // Loading state — show live progress
  if (loading && !diagram) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <div style={{ fontSize: 14, color: "#60a5fa", fontWeight: 600 }}>
          <BrailleSpinner /> Generating architecture diagram...
        </div>

        {/* Live progress log */}
        <div style={{
          width: "100%", maxWidth: 500, maxHeight: 300,
          background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 10,
          padding: "12px 16px", overflowY: "auto",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 11, lineHeight: 1.8,
        }}>
          {progressLog.length === 0 && (
            <div style={{ color: "#333" }}>Waiting for events...</div>
          )}
          {progressLog.map((msg, i) => {
            const isLast = i === progressLog.length - 1;
            let icon = "✓";
            let color = "#4ade80";
            if (isLast) { icon = "▶"; color = "#60a5fa"; }
            if (msg.includes("BLOCK")) { icon = "✗"; color = "#f87171"; }
            if (msg.includes("WARN")) { icon = "⚠"; color = "#facc15"; }
            if (msg.includes("PASS")) { icon = "✓"; color = "#4ade80"; }
            if (msg.includes("error") || msg.includes("Failed")) { icon = "✗"; color = "#f87171"; }
            return (
              <div key={i} style={{ color: isLast ? color : "#555" }}>
                <span style={{ marginRight: 8 }}>{isLast ? icon : "✓"}</span>
                {msg}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Provider selector pill
  const pill = (label: string, value: string, current: string, set: (v: any) => void) => (
    <button
      onClick={() => set(value)}
      style={{
        padding: "5px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
        border: current === value ? "1px solid #2563eb" : "1px solid #222",
        background: current === value ? "#1e3a5f" : "#111",
        color: current === value ? "#60a5fa" : "#666",
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );

  // Empty state (no diagram yet, not loading)
  if (!diagram && !loading && !error) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#fff", margin: 0 }}>Diagram Mode</h2>
        <p style={{ color: "#555", fontSize: 13, maxWidth: 400, textAlign: "center" }}>
          Generate an architecture diagram of your project.
        </p>

        {/* Provider selectors */}
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#555", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Generator</span>
            <div style={{ display: "flex", gap: 4 }}>
              {pill("Claude", "claude", generator, setGenerator)}
              {pill("GPT", "gpt", generator, setGenerator)}
            </div>
          </div>
          <div style={{ width: 1, height: 36, background: "#222" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#555", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Verifier</span>
            <div style={{ display: "flex", gap: 4 }}>
              {pill("Claude", "claude", verifier, setVerifier)}
              {pill("GPT", "gpt", verifier, setVerifier)}
            </div>
          </div>
        </div>

        <button
          onClick={generate}
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
          onClick={generate}
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

  // Toolbar button style
  const tbBtn = (active?: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 6, border: "1px solid #222",
    background: active ? "#1e3a5f" : "#111", color: active ? "#60a5fa" : "#999",
    cursor: "pointer", fontSize: 11, fontWeight: 500, transition: "all 0.15s",
    whiteSpace: "nowrap",
  });

  // Diagram view
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "#060606" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
        borderBottom: "1px solid #1a1a1a", flexShrink: 0, background: "#0a0a0a",
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#ccc" }}>Architecture</span>
        <span style={{ fontSize: 10, color: "#444", fontFamily: "monospace" }}>
          {filesScanned} files
        </span>
        <div style={{ flex: 1 }} />

        {loading && <span style={{ fontSize: 11, color: "#60a5fa" }}><BrailleSpinner /> Updating...</span>}

        {/* Zoom controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: 8 }}>
          <button onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))} style={tbBtn()}> - </button>
          <span style={{ fontSize: 10, color: "#666", minWidth: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(5, z + 0.2))} style={tbBtn()}> + </button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={tbBtn(zoom === 1 && pan.x === 0 && pan.y === 0)}>Fit</button>
        </div>

        <button onClick={copyCode} style={tbBtn()}>Copy Code</button>
        {shareUrl && (
          <a href={shareUrl} target="_blank" rel="noopener noreferrer"
            style={{ ...tbBtn(), color: "#60a5fa", textDecoration: "none", display: "inline-block" }}>
            Mermaid Live
          </a>
        )}
        <button onClick={generate} disabled={loading} style={tbBtn()}>
          {loading ? "..." : "Regenerate"}
        </button>
      </div>

      {/* Diagram viewport — drag to pan, Ctrl+scroll to zoom */}
      <div
        ref={viewportRef}
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setZoom((z) => Math.min(5, Math.max(0.2, z - e.deltaY * 0.003)));
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{
          flex: 1, overflow: "hidden",
          cursor: dragging ? "grabbing" : "grab",
          background: "radial-gradient(circle at center, #0d0d0d 0%, #060606 100%)",
          userSelect: "none",
        }}
      >
        <div
          ref={containerRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            padding: "32px 24px",
            minWidth: "fit-content",
            transition: dragging ? "none" : "transform 0.15s ease-out",
          }}
        />
      </div>
    </div>
  );
}
