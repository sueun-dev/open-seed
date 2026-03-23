import React from "react";

const STEPS = [
  { id: "intake", label: "Intake", icon: "🧠" },
  { id: "plan", label: "Plan", icon: "📋" },
  { id: "implement", label: "Build", icon: "🔨" },
  { id: "qa_gate", label: "QA Gate", icon: "⚖️" },
  { id: "sentinel_check", label: "Sentinel", icon: "♾️" },
  { id: "deploy", label: "Deploy", icon: "🚀" },
  { id: "memorize", label: "Memory", icon: "💾" },
];

type Props = { events: any[] };

export default function Pipeline({ events }: Props) {
  const completed = new Set<string>();
  const failed = new Set<string>();
  let active = "";

  for (const e of events) {
    if (e.type === "node.start") active = e.node;
    if (e.type === "node.complete") { completed.add(e.node); if (active === e.node) active = ""; }
    if (e.type === "node.error") failed.add(e.node);
  }

  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
      {STEPS.map((step, i) => {
        const isActive = step.id === active;
        const isDone = completed.has(step.id);
        const isFailed = failed.has(step.id);

        let bg = "#111";
        let border = "1px solid #222";
        let textColor = "#555";

        if (isFailed) { bg = "#2d1111"; border = "1px solid #7f1d1d"; textColor = "#f87171"; }
        else if (isDone) { bg = "#0d2818"; border = "1px solid #14532d"; textColor = "#4ade80"; }
        else if (isActive) { bg = "#0c1a2e"; border = "2px solid #2563eb"; textColor = "#60a5fa"; }

        return (
          <React.Fragment key={step.id}>
            <div style={{
              flex: 1, padding: "10px 6px", borderRadius: 8, background: bg,
              border, textAlign: "center", transition: "all 0.3s",
            }}>
              <div style={{ fontSize: 16, marginBottom: 2 }}>{step.icon}</div>
              <div style={{ fontSize: 11, color: textColor, fontWeight: isActive ? 700 : 500 }}>
                {step.label}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ display: "flex", alignItems: "center", color: "#333", fontSize: 14 }}>→</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
