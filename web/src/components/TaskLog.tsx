import React, { useEffect, useRef } from "react";

type Props = { events: any[] };

export default function TaskLog({ events }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div style={{
      height: "100%", background: "#080808", border: "1px solid #1a1a1a",
      borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        padding: "8px 14px", borderBottom: "1px solid #1a1a1a",
        fontSize: 11, fontWeight: 600, color: "#555", display: "flex",
        justifyContent: "space-between", alignItems: "center", flexShrink: 0,
      }}>
        <span>Activity</span>
        <span style={{ fontFamily: "monospace", fontSize: 10 }}>{events.length} events</span>
      </div>

      {/* Log */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "8px 14px",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11, lineHeight: 1.8,
      }}>
        {events.length === 0 && <div style={{ color: "#333", padding: "12px 0" }}>Waiting for events...</div>}
        {events.map((e, i) => formatEvent(e, i))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function formatEvent(e: any, i: number) {
  const t = e.type || "";
  const node = e.node || "";
  const data = e.data || {};
  const msg = data.message || data.text || "";

  let color = "#555";
  let icon = "·";
  let text = "";

  switch (t) {
    case "pipeline.start":
      color = "#60a5fa"; icon = "▶"; text = `Pipeline started: ${data.task || ""}`;
      break;
    case "pipeline.complete":
      color = "#4ade80"; icon = "✓"; text = "Pipeline COMPLETE - zero errors";
      break;
    case "pipeline.fail":
      color = "#f87171"; icon = "✗"; text = `Pipeline FAILED: ${data.error || ""}`;
      break;
    case "node.start":
      color = "#60a5fa"; icon = "▶"; text = node;
      break;
    case "node.complete":
      color = "#333"; icon = "✓"; text = node;
      break;
    case "node.log":
      color = "#888"; icon = "│"; text = msg;
      break;
    case "node.plan":
      color = "#c084fc"; icon = "📋";
      text = `${data.summary || ""} (${data.tasks} tasks, ${data.files} files)`;
      break;
    case "node.implementation":
      color = "#34d399"; icon = "🔨";
      text = data.summary?.slice(0, 150) || "";
      break;
    case "node.qa":
      color = data.verdict === "pass" ? "#4ade80" : data.verdict === "block" ? "#f87171" : "#facc15";
      icon = "⚖"; text = `QA: ${data.verdict?.toUpperCase()} - ${data.findings} findings`;
      break;
    case "node.deploy":
      color = data.success ? "#4ade80" : "#f87171";
      icon = "🚀"; text = data.message || "";
      break;
    case "node.retry":
      color = "#fb923c"; icon = "↻"; text = `Retry #${data.retry_count}`;
      break;
    case "node.error":
      color = "#f87171"; icon = "✗"; text = data.message;
      break;
    case "error":
      color = "#f87171"; icon = "✗"; text = msg || JSON.stringify(data);
      break;
    // Intake sub-step progress events
    case "intake.context":
      color = "#818cf8"; icon = "🔍"; text = msg;
      break;
    case "intake.gaps":
      color = "#c084fc"; icon = "🧠"; text = msg;
      break;
    case "intake.skills":
      color = "#a78bfa"; icon = "🛠"; text = msg;
      break;
    case "intake.research":
      color = "#60a5fa"; icon = "🌐"; text = msg;
      break;
    case "intake.questions":
      color = "#818cf8"; icon = "❓"; text = msg;
      break;
    case "intake.plan":
      color = "#c084fc"; icon = "📝"; text = msg;
      break;
    // Plan sub-step progress events
    case "plan.convert":
      color = "#c084fc"; icon = "🔄"; text = msg;
      break;
    case "plan.generate":
      color = "#c084fc"; icon = "📋"; text = msg;
      break;
    // Implement sub-step progress events
    case "implement.start":
      color = "#60a5fa"; icon = "▶"; text = msg;
      break;
    case "implement.routing":
      color = "#c084fc"; icon = "🔀"; text = msg;
      break;
    case "implement.specialists":
      color = "#818cf8"; icon = "👥";
      text = msg;
      break;
    case "implement.specialist_start":
      color = "#a78bfa"; icon = "⚙";
      text = msg;
      break;
    case "implement.specialist_done":
      color = "#4ade80"; icon = "✓"; text = msg;
      break;
    case "implement.integration":
      color = "#fbbf24"; icon = "🔗"; text = msg;
      break;
    case "implement.integration_done":
      color = "#4ade80"; icon = "✓"; text = msg;
      break;
    case "implement.verify":
      color = "#fb923c"; icon = "🔍"; text = msg;
      break;
    case "implement.done":
      color = "#4ade80"; icon = "✓"; text = msg;
      break;
    default:
      text = msg || JSON.stringify(data).slice(0, 120);
  }

  if (!text) return null;

  return (
    <div key={i} style={{ color, whiteSpace: "pre-wrap", marginBottom: 1 }}>
      <span style={{ color: "#333", marginRight: 6 }}>{icon}</span>
      {node && <span style={{ color: "#444", marginRight: 8 }}>{node}</span>}
      {text}
    </div>
  );
}
