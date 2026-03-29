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

export default function PairMode({ activeThread, workingDir, setWorkingDir, createThread, updateThreadEvents }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");
  const [rightTab, setRightTab] = useState<"chat" | "changes">("chat");
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
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
        body: JSON.stringify({ message: input, working_dir: workingDir, session_id: sessionId, provider }),
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

  // Empty state
  if (messages.length === 0 && !streaming) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>👥</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>Pair Mode</h2>
          <p style={{ color: "#555", fontSize: 13, maxWidth: 400 }}>
            Code on the left, chat on the right. Review changes together.
          </p>
        </div>

        {/* Suggested actions */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 500 }}>
          {[
            { icon: "🔍", text: "Review the auth module for security issues" },
            { icon: "🐛", text: "Fix the failing test in user.test.ts" },
            { icon: "♻️", text: "Refactor the database layer" },
          ].map((s) => (
            <button key={s.text} onClick={() => setInput(s.text)} style={{
              padding: "10px 14px", borderRadius: 10, border: "1px solid #222",
              background: "#111", color: "#999", cursor: "pointer", fontSize: 12,
              textAlign: "left", maxWidth: 180, transition: "border-color 0.15s",
            }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#222"}
            >
              <span style={{ fontSize: 16, display: "block", marginBottom: 4 }}>{s.icon}</span>
              {s.text}
            </button>
          ))}
        </div>

        {/* Provider selector */}
        <div style={{ display: "flex", gap: 6 }}>
          {(["claude", "codex", "both"] as const).map((p) => (
            <button key={p} onClick={() => setProvider(p)} style={{
              padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: provider === p ? "1px solid #2563eb" : "1px solid #222",
              background: provider === p ? "#1e3a5f" : "#111",
              color: provider === p ? "#60a5fa" : "#666",
              transition: "all 0.15s",
            }}>
              {p === "claude" ? "🟣 Claude" : p === "codex" ? "🟢 Codex" : "⚡ Both (Debate)"}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ width: "100%", maxWidth: 560, padding: "0 24px" }}>
          <div style={{
            display: "flex", gap: 8, padding: "8px 12px",
            background: "#0d0d0d", borderRadius: 12, border: "1px solid #222",
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Ask anything..."
              style={{
                flex: 1, padding: "8px 4px", border: "none",
                background: "transparent", color: "#eee", fontSize: 14, outline: "none",
              }}
            />
            <button onClick={sendMessage} disabled={!input.trim()} style={{
              width: 36, height: 36, borderRadius: 8, border: "none",
              background: input.trim() ? "#2563eb" : "#222",
              color: input.trim() ? "#fff" : "#555",
              cursor: input.trim() ? "pointer" : "default",
              fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              ↑
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main layout: [Code Viewer] [Chat + Changes] ──
  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* LEFT: Code Viewer */}
      <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid #1a1a1a" }}>
        <CodeViewer workingDir={workingDir} highlightFiles={changedFiles} />
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
          <DiffPanel diffs={diffs} onClose={() => setRightTab("chat")} />
        )}
      </div>
    </div>
  );
}
