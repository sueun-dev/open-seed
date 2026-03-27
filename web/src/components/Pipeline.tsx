import React from "react";

const STEPS = [
  { id: "intake", label: "Intake", icon: "🧠" },
  { id: "plan", label: "Plan", icon: "📋" },
  { id: "implement", label: "Build", icon: "🔨" },
  { id: "qa_gate", label: "QA", icon: "⚖️" },
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
    <div style={{ display: "flex", gap: 4, marginBottom: 16, padding: "12px 0" }}>
      {STEPS.map((step, i) => {
        const isActive = step.id === active;
        const isDone = completed.has(step.id);
        const isFailed = failed.has(step.id);

        let bg = "#0d0d0d";
        let border = "1px solid #1a1a1a";
        let textColor = "#444";
        let iconOpacity = 0.4;

        if (isFailed) { bg = "#1a0a0a"; border = "1px solid #7f1d1d"; textColor = "#f87171"; iconOpacity = 1; }
        else if (isDone) { bg = "#0a1a0d"; border = "1px solid #14532d"; textColor = "#4ade80"; iconOpacity = 1; }
        else if (isActive) { bg = "#0c1a2e"; border = "1px solid #2563eb"; textColor = "#60a5fa"; iconOpacity = 1; }

        return (
          <React.Fragment key={step.id}>
            <div style={{
              flex: 1, padding: "8px 4px", borderRadius: 8, background: bg,
              border, textAlign: "center", transition: "all 0.2s", minWidth: 0,
            }}>
              <div style={{ fontSize: 14, marginBottom: 2, opacity: iconOpacity, transition: "opacity 0.2s" }}>{step.icon}</div>
              <div style={{ fontSize: 10, color: textColor, fontWeight: isActive ? 700 : 500, transition: "color 0.2s" }}>
                {step.label}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{
                display: "flex", alignItems: "center",
                color: isDone || completed.has(STEPS[i + 1]?.id) ? "#14532d" : "#1a1a1a",
                fontSize: 10, transition: "color 0.2s",
              }}>→</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
