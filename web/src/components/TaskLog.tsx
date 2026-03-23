import React, { useEffect, useRef } from "react";

type Props = { events: any[] };

export default function TaskLog({ events }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const formatEvent = (e: any, i: number) => {
    const t = e.type || "";
    const node = e.node || "sys";
    const data = e.data || {};
    const msg = data.message || data.text || "";

    // Color by event type
    let color = "#888";
    let icon = "·";
    let text = "";

    switch (t) {
      case "pipeline.start":
        color = "#60a5fa"; icon = "▶"; text = `Pipeline started: ${data.task || ""}`;
        break;
      case "pipeline.complete":
        color = "#4ade80"; icon = "✓"; text = "Pipeline COMPLETE";
        break;
      case "pipeline.fail":
        color = "#f87171"; icon = "✗"; text = `Pipeline FAILED: ${data.error || ""}`;
        break;
      case "node.start":
        color = "#60a5fa"; icon = "▶"; text = `${node} started`;
        break;
      case "node.complete":
        color = "#4ade80"; icon = "✓"; text = `${node} complete`;
        break;
      case "node.log":
        color = "#d1d5db"; icon = "│"; text = msg;
        break;
      case "node.plan":
        color = "#c084fc"; icon = "📋";
        text = `Plan: ${data.summary || ""} (${data.tasks} tasks, ${data.files} files)`;
        if (data.file_list?.length) text += `\n    Files: ${data.file_list.join(", ")}`;
        break;
      case "node.implementation":
        color = "#34d399"; icon = "🔨";
        text = `Implementation: ${data.summary?.slice(0, 200) || ""}`;
        if (data.files_created?.length) text += `\n    Created: ${data.files_created.join(", ")}`;
        if (data.files_modified?.length) text += `\n    Modified: ${data.files_modified.join(", ")}`;
        break;
      case "node.qa":
        color = data.verdict === "pass" ? "#4ade80" : data.verdict === "block" ? "#f87171" : "#facc15";
        icon = "⚖"; text = `QA: ${data.verdict?.toUpperCase()} — ${data.findings} findings. ${data.synthesis || ""}`;
        break;
      case "node.deploy":
        color = data.success ? "#4ade80" : "#f87171";
        icon = "🚀"; text = `Deploy: ${data.message || ""}`;
        break;
      case "node.retry":
        color = "#fb923c"; icon = "↻"; text = `Retry #${data.retry_count}`;
        break;
      case "node.error":
        color = "#f87171"; icon = "✗"; text = `ERROR [${data.severity}]: ${data.message}`;
        break;
      case "started":
        color = "#60a5fa"; icon = "▶"; text = `Request sent: ${JSON.stringify(data).slice(0, 100)}`;
        break;
      case "error":
        color = "#f87171"; icon = "✗"; text = msg || JSON.stringify(data);
        break;
      default:
        text = msg || JSON.stringify(data).slice(0, 200);
    }

    return (
      <div key={i} style={{ color, whiteSpace: "pre-wrap", marginBottom: 2 }}>
        <span style={{ color: "#555", marginRight: 6 }}>{icon}</span>
        <span style={{ color: "#666", marginRight: 8, fontSize: 11 }}>{node}</span>
        {text}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#999", marginBottom: 8 }}>
        Activity Log ({events.length} events)
      </div>
      <div
        style={{
          background: "#0a0a0a", border: "1px solid #222", borderRadius: 8,
          padding: 14, maxHeight: 500, overflowY: "auto", fontSize: 12,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace", lineHeight: 1.7,
        }}
      >
        {events.length === 0 && <div style={{ color: "#444" }}>Waiting for pipeline events...</div>}
        {events.map((e, i) => formatEvent(e, i))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
