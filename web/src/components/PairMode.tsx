import React, { useState, useRef, useEffect } from "react";
import CodeViewer from "./CodeViewer";
import DiffPanel from "./DiffPanel";
import { ThinkingSpinner } from "./Spinner";
import type { Thread, Mode } from "../App";

type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  files?: string[];
};

type Props = {
  activeThread: Thread | null;
  workingDir: string;
  setWorkingDir: (dir: string) => void;
  createThread: (name: string, mode: Mode) => string;
  updateThreadEvents: (threadId: string, events: any[]) => void;
};

type HarnessStatus = {
  total: number;
  passing: boolean;
  missing: string[];
  checking: boolean;
};

export default function PairMode({ activeThread, workingDir, setWorkingDir, createThread, updateThreadEvents }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");
  const [rightTab, setRightTab] = useState<"chat" | "changes">("chat");
  const [changedFiles, setChangedFiles] = useState<string[]>([]);

  // Harness quality state (info only — setup handled by backend on chat)
  const [harness, setHarness] = useState<HarnessStatus>({ total: 0, passing: true, missing: [], checking: false });

  useEffect(() => {
    if (!workingDir) return;
    let cancelled = false;
    setHarness(prev => ({ ...prev, checking: true }));
    fetch("/api/harness/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ working_dir: workingDir }),
    })
      .then(res => res.json())
      .then(data => {
        if (!cancelled) {
          setHarness({ total: data.total, passing: data.passing, missing: data.missing || [], checking: false });
        }
      })
      .catch(() => {
        if (!cancelled) setHarness({ total: 0, passing: true, missing: [], checking: false });
      });
    return () => { cancelled = true; };
  }, [workingDir]);
  const [viewingFiles, setViewingFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    const userMsg: Message = { role: "user", content: input, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);

    if (!activeThread) {
      createThread(input.slice(0, 60), "pair");
    }

    // WebSocket for debate events (Both mode)
    let ws: WebSocket | null = null;
    if (provider === "both") {
      try {
        ws = new WebSocket(`ws://${location.host}/ws/events`);
        ws.onmessage = (e) => {
          try {
            const event = JSON.parse(e.data);
            if (event.type === "debate.start") {
              setMessages((prev) => [...prev, { role: "assistant", content: "⚡ " + event.data.message, timestamp: new Date().toISOString() }]);
            } else if (event.type === "debate.opinion") {
              const icon = event.data.speaker === "claude" ? "🟣" : "🟢";
              const name = event.data.speaker === "claude" ? "Claude" : "Codex";
              setMessages((prev) => [...prev, { role: "assistant", content: `${icon} **${name}:**\n${event.data.message}`, timestamp: new Date().toISOString() }]);
            } else if (event.type === "debate.deciding") {
              setMessages((prev) => [...prev, { role: "assistant", content: "⚖️ " + event.data.message, timestamp: new Date().toISOString() }]);
            } else if (event.type === "debate.verdict") {
              setMessages((prev) => [...prev, { role: "assistant", content: "✅ " + event.data.verdict, timestamp: new Date().toISOString() }]);
            }
          } catch {}
        };
        await new Promise<void>((resolve) => { if (ws) ws.onopen = () => resolve(); setTimeout(resolve, 500); });
      } catch {}
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input, working_dir: workingDir, session_id: sessionId, provider,
          viewing_files: viewingFiles, active_file: activeFile,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      if (data.session_id) setSessionId(data.session_id);

      setMessages((prev) => [...prev, {
        role: "assistant", content: data.response, timestamp: new Date().toISOString(),
        files: [...(data.files_created || []), ...(data.files_modified || [])],
      }]);

      // Track file changes
      const allChanged = [...(data.files_created || []), ...(data.files_modified || [])];
      if (allChanged.length) {
        setChangedFiles(allChanged);
        setDiffs((prev) => [...prev, {
          files_created: data.files_created || [],
          files_modified: data.files_modified || [],
          summary: data.response?.slice(0, 200) || "",
        }]);
        // Auto-switch to changes tab when files change
        setRightTab("changes");
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: String(err).includes("fetch") ? "Backend not running. Start with: openseed serve --port 8000" : String(err),
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setStreaming(false);
      if (ws) try { ws.close(); } catch {}
    }
  };

  // ── Always show: [Code Viewer] [Chat + Changes] ──
  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* LEFT: Code Viewer */}
      <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid #1a1a1a" }}>
        <CodeViewer
          workingDir={workingDir}
          highlightFiles={changedFiles}
          onOpenFilesChange={(files, active) => { setViewingFiles(files); setActiveFile(active); }}
        />
      </div>

      {/* RIGHT: Chat + Changes */}
      <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", background: "#0a0a0a" }}>
        {/* Tab bar */}
        <div style={{
          height: 36, borderBottom: "1px solid #1a1a1a", display: "flex",
          alignItems: "center", padding: "0 4px", gap: 2, flexShrink: 0,
        }}>
          <button
            onClick={() => setRightTab("chat")}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600,
              background: rightTab === "chat" ? "#1a1a1a" : "transparent",
              color: rightTab === "chat" ? "#ddd" : "#666",
              cursor: "pointer", transition: "all 0.15s",
            }}
          >
            Chat
          </button>
          <button
            onClick={() => setRightTab("changes")}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600,
              background: rightTab === "changes" ? "#1a1a1a" : "transparent",
              color: rightTab === "changes" ? "#ddd" : "#666",
              cursor: "pointer", transition: "all 0.15s",
              display: "flex", alignItems: "center", gap: 4,
            }}
          >
            Changes
            {diffs.length > 0 && (
              <span style={{
                fontSize: 9, background: "#2563eb", color: "#fff",
                padding: "1px 5px", borderRadius: 8, fontWeight: 700,
              }}>
                {diffs.reduce((a, d) => a + (d.files_created?.length || 0) + (d.files_modified?.length || 0), 0)}
              </span>
            )}
          </button>
          {/* Provider indicator */}
          <div style={{ marginLeft: "auto", fontSize: 10, color: "#444", paddingRight: 8 }}>
            {provider === "claude" ? "🟣" : provider === "codex" ? "🟢" : "⚡"}
          </div>
        </div>

        {/* Tab content */}
        {rightTab === "chat" ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
              {/* Welcome + provider selector when empty */}
              {messages.length === 0 && !streaming && (
                <div style={{ padding: "20px 8px", display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>👥</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#ddd" }}>Pair Mode</div>
                    <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Browse code, ask questions</div>
                  </div>
                  {/* Provider selector */}
                  <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                    {(["claude", "codex", "both"] as const).map((p) => (
                      <button key={p} onClick={() => setProvider(p)} style={{
                        padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer",
                        border: provider === p ? "1px solid #2563eb" : "1px solid #222",
                        background: provider === p ? "#1e3a5f" : "#111",
                        color: provider === p ? "#60a5fa" : "#666",
                        transition: "all 0.15s",
                      }}>
                        {p === "claude" ? "🟣 Claude" : p === "codex" ? "🟢 Codex" : "⚡ Both"}
                      </button>
                    ))}
                  </div>
                  {/* Harness banner (info only — setup handled by backend on first message) */}
                  {!harness.checking && !harness.passing && (
                    <div style={{
                      background: "#1a1207", border: "1px solid #854d0e", borderRadius: 8,
                      padding: "10px 14px",
                    }}>
                      <span style={{ color: "#fbbf24", fontSize: 11, fontWeight: 600 }}>
                        Harness: {harness.total}/100
                      </span>
                      <span style={{ color: "#a3a3a3", fontSize: 10, marginLeft: 6 }}>
                        — will be set up on first message
                      </span>
                      <div style={{ color: "#a3a3a3", fontSize: 10, lineHeight: 1.4, marginTop: 4 }}>
                        {harness.missing.slice(0, 3).map((m, i) => (
                          <div key={i}>- {m}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {!harness.checking && harness.passing && harness.total > 0 && (
                    <div style={{ color: "#22c55e", fontSize: 11, fontWeight: 500, textAlign: "center" }}>
                      Harness: {harness.total}/100
                    </div>
                  )}
                  {/* Suggestions */}
                  {[
                    "Review this file for issues",
                    "Explain the architecture",
                    "Fix the bug in this function",
                  ].map((s) => (
                    <button key={s} onClick={() => setInput(s)} style={{
                      padding: "8px 10px", borderRadius: 8, border: "1px solid #1a1a1a",
                      background: "#0d0d0d", color: "#888", cursor: "pointer", fontSize: 11,
                      textAlign: "left", transition: "border-color 0.15s",
                    }}
                      onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
                      onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1a1a1a"}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} style={{
                  marginBottom: 10, padding: "8px 10px", borderRadius: 8,
                  background: msg.role === "user" ? "#111" : "transparent",
                  borderLeft: msg.role === "assistant" ? "2px solid #2563eb" : "none",
                }}>
                  <div style={{ fontSize: 10, color: "#555", marginBottom: 2, fontWeight: 600 }}>
                    {msg.role === "user" ? "You" : "AI"}
                  </div>
                  <div style={{
                    fontSize: 12, color: msg.role === "user" ? "#eee" : "#ccc",
                    lineHeight: 1.5, whiteSpace: "pre-wrap",
                    fontFamily: msg.role === "assistant" ? "'JetBrains Mono', 'Fira Code', monospace" : "inherit",
                  }}>
                    {msg.content}
                  </div>
                  {msg.files && msg.files.length > 0 && (
                    <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {msg.files.map((f) => (
                        <span key={f} style={{
                          fontSize: 10, color: "#4ade80", background: "#0d2818",
                          padding: "1px 6px", borderRadius: 3, fontFamily: "monospace",
                        }}>
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {streaming && <ThinkingSpinner />}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={{ padding: "8px 12px 12px", borderTop: "1px solid #1a1a1a" }}>
              <div style={{
                display: "flex", gap: 6, padding: "6px 10px",
                background: "#0d0d0d", borderRadius: 10, border: "1px solid #222",
              }}>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder={streaming ? "AI is working..." : "Message..."}
                  disabled={streaming}
                  style={{
                    flex: 1, padding: "6px 2px", border: "none",
                    background: "transparent", color: "#eee", fontSize: 12, outline: "none",
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={streaming || !input.trim()}
                  style={{
                    width: 28, height: 28, borderRadius: 6, border: "none",
                    background: !streaming && input.trim() ? "#2563eb" : "#222",
                    color: !streaming && input.trim() ? "#fff" : "#555",
                    cursor: !streaming && input.trim() ? "pointer" : "default",
                    fontSize: 12,
                  }}
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        ) : (
          <DiffPanel diffs={diffs} onClose={() => setRightTab("chat")} workingDir={workingDir} />
        )}
      </div>
    </div>
  );
}
