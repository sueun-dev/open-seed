import React, { useEffect, useRef } from "react";

type Props = { events: any[] };

export default function TaskLog({ events }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div
      style={{
        background: "#0a0a0a", border: "1px solid #222", borderRadius: 8,
        padding: 12, maxHeight: 400, overflowY: "auto", fontSize: 12,
        fontFamily: "monospace", lineHeight: 1.6,
      }}
    >
      {events.length === 0 && <div style={{ color: "#555" }}>Waiting for pipeline events...</div>}
      {events.map((e, i) => {
        const color =
          e.type === "node.complete" || e.type === "pipeline.complete" ? "#4ade80" :
          e.type === "node.fail" || e.type === "pipeline.fail" || e.type === "error" ? "#f87171" :
          e.type === "node.start" ? "#60a5fa" :
          e.type === "qa.verdict" ? "#facc15" :
          e.type === "sisyphus.retry" ? "#fb923c" :
          "#888";

        const text = e.data?.message || e.data?.text || e.type;
        return (
          <div key={i} style={{ color }}>
            <span style={{ color: "#555" }}>{e.node || "sys"}</span>{" "}
            {String(text).slice(0, 200)}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
