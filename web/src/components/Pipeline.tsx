import React from "react";

const STEPS = ["intake", "plan", "implement", "qa_gate", "sisyphus_check", "deploy", "memorize"];

type Props = { events: any[] };

export default function Pipeline({ events }: Props) {
  const activeNode = events
    .filter((e) => e.type === "node.start")
    .map((e) => e.node)
    .pop();

  const completedNodes = new Set(
    events.filter((e) => e.type === "node.complete").map((e) => e.node)
  );
  const failedNodes = new Set(
    events.filter((e) => e.type === "node.fail").map((e) => e.node)
  );

  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
      {STEPS.map((step) => {
        const isActive = step === activeNode;
        const isDone = completedNodes.has(step);
        const isFailed = failedNodes.has(step);
        const bg = isFailed ? "#7f1d1d" : isDone ? "#14532d" : isActive ? "#1e3a5f" : "#1a1a1a";
        const border = isActive ? "2px solid #3b82f6" : "1px solid #333";
        return (
          <div
            key={step}
            style={{
              flex: 1, padding: "8px 6px", borderRadius: 6, background: bg,
              border, textAlign: "center", fontSize: 11, color: "#ccc",
            }}
          >
            {step.replace("_", " ")}
          </div>
        );
      })}
    </div>
  );
}
