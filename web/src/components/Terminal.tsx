import React, { useState, useRef, useEffect, useCallback } from "react";

type Props = {
  workingDir: string;
};

type LogEntry = {
  type: "command" | "output" | "error" | "info";
  content: string;
};

export default function Terminal({ workingDir }: Props) {
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState(workingDir);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  // Connect WebSocket
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "init", working_dir: workingDir }));
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "ready") {
          setCwd(data.cwd);
          setLogs((prev) => [...prev, { type: "info", content: `Connected. Working dir: ${data.cwd}` }]);
        } else if (data.type === "output") {
          setLogs((prev) => {
            // Append to last output entry if consecutive
            const last = prev[prev.length - 1];
            if (last && last.type === "output") {
              const updated = [...prev];
              updated[updated.length - 1] = { ...last, content: last.content + data.data };
              return updated;
            }
            return [...prev, { type: "output", content: data.data }];
          });
        } else if (data.type === "exit") {
          setRunning(false);
          if (data.cwd) setCwd(data.cwd);
        }
      } catch {}
    };

    ws.onclose = () => {
      setLogs((prev) => [...prev, { type: "info", content: "Terminal disconnected." }]);
    };

    return () => {
      ws.close();
    };
  }, [workingDir]);

  const runCommand = useCallback(() => {
    if (!input.trim() || running || !wsRef.current) return;
    const cmd = input.trim();
    setInput("");
    setRunning(true);
    setHistory((prev) => [cmd, ...prev.filter((h) => h !== cmd)].slice(0, 50));
    setHistoryIdx(-1);

    setLogs((prev) => [...prev, { type: "command", content: cmd }]);
    wsRef.current.send(JSON.stringify({ type: "command", command: cmd }));
  }, [input, running]);

  const killProcess = useCallback(() => {
    if (wsRef.current && running) {
      wsRef.current.send(JSON.stringify({ type: "kill" }));
    }
  }, [running]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      runCommand();
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      killProcess();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      } else {
        setHistoryIdx(-1);
        setInput("");
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLogs([]);
    }
  };

  // Focus input on click anywhere in terminal
  const focusInput = () => inputRef.current?.focus();

  // Shorten cwd for display
  const displayCwd = cwd.replace(/^\/Users\/[^/]+/, "~");

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0a0a" }}
      onClick={focusInput}
    >
      {/* Output */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "6px 12px",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12,
      }}>
        {logs.map((log, i) => (
          <div key={i}>
            {log.type === "command" ? (
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "#2563eb", flexShrink: 0 }}>{displayCwd}</span>
                <span style={{ color: "#555", flexShrink: 0 }}>$</span>
                <span style={{ color: "#4ade80" }}>{log.content}</span>
              </div>
            ) : log.type === "info" ? (
              <div style={{ color: "#555", fontSize: 11, fontStyle: "italic" }}>{log.content}</div>
            ) : (
              <pre style={{
                margin: 0, paddingLeft: 14, color: "#999",
                whiteSpace: "pre-wrap", wordBreak: "break-all",
                fontSize: 11, lineHeight: 1.4,
              }}>
                {log.content}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input line */}
      <div style={{
        padding: "4px 12px 6px", borderTop: "1px solid #111",
        display: "flex", gap: 6, alignItems: "center",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      }}>
        <span style={{ color: "#2563eb", fontSize: 12, flexShrink: 0 }}>{displayCwd}</span>
        <span style={{ color: "#555", fontSize: 12, flexShrink: 0 }}>$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? "running... (Ctrl+C to stop)" : ""}
          style={{
            flex: 1, padding: "2px 0", border: "none", background: "transparent",
            color: "#eee", fontSize: 12, outline: "none",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {running && (
          <button
            onClick={killProcess}
            style={{
              padding: "2px 8px", borderRadius: 4, border: "1px solid #333",
              background: "transparent", color: "#f87171", cursor: "pointer",
              fontSize: 10, fontWeight: 600, flexShrink: 0,
            }}
          >
            Kill
          </button>
        )}
      </div>
    </div>
  );
}
