import React, { useState, useRef, useEffect } from "react";

type Props = {
  workingDir: string;
};

type LogEntry = {
  command: string;
  output: string;
  timestamp: string;
  exitCode?: number;
};

export default function Terminal({ workingDir }: Props) {
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  const runCommand = async () => {
    if (!input.trim() || running) return;
    const cmd = input.trim();
    setInput("");
    setRunning(true);

    setLogs((prev) => [...prev, { command: cmd, output: "", timestamp: new Date().toISOString() }]);

    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, working_dir: workingDir }),
      });
      const data = await res.json();
      setLogs((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          output: data.output || "",
          exitCode: data.exit_code,
        };
        return updated;
      });
    } catch (err) {
      setLogs((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          output: `Error: ${err}`,
          exitCode: 1,
        };
        return updated;
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0a0a" }}>
      {/* Output */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12 }}>
        {logs.length === 0 && (
          <div style={{ color: "#444", fontSize: 11, padding: "4px 0" }}>
            Terminal ready. Working dir: {workingDir}
          </div>
        )}
        {logs.map((log, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 6, color: "#4ade80" }}>
              <span style={{ color: "#555" }}>$</span>
              <span>{log.command}</span>
            </div>
            {log.output && (
              <pre style={{
                margin: "2px 0 0 14px", color: log.exitCode !== 0 ? "#f87171" : "#999",
                whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, lineHeight: 1.4,
              }}>
                {log.output}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "6px 12px 8px", borderTop: "1px solid #1a1a1a" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: "#4ade80", fontSize: 12, fontFamily: "monospace", flexShrink: 0 }}>$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runCommand()}
            placeholder={running ? "Running..." : "Enter command..."}
            disabled={running}
            style={{
              flex: 1, padding: "6px 4px", border: "none", background: "transparent",
              color: "#eee", fontSize: 12, outline: "none",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
}
