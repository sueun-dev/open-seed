import React, { useState, useRef, useEffect } from "react";
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
  const [showDiff, setShowDiff] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");
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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input,
          working_dir: workingDir,
          session_id: sessionId,
          provider,
        }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      // Save session for multi-turn conversation
      if (data.session_id) setSessionId(data.session_id);

      // Add assistant message
      const label = provider === "both" ? "Claude + Codex" : provider === "codex" ? "Codex" : "Claude";
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: data.response,
        timestamp: new Date().toISOString(),
        files: [...(data.files_created || []), ...(data.files_modified || [])],
      }]);

      // Show file changes in diff panel
      if (data.files_created?.length || data.files_modified?.length) {
        setDiffs((prev) => [...prev, {
          files_created: data.files_created,
          files_modified: data.files_modified,
          summary: data.response?.slice(0, 200) || "",
        }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: String(err).includes("fetch") ? "Backend not running. Start with: openseed serve --port 8000" : String(err),
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setStreaming(false);
    }
  };

  // Empty state
  if (messages.length === 0 && !streaming) {
    return (
      <div style={{ height: "100%", display: "flex" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>👥</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>Pair Mode</h2>
            <p style={{ color: "#555", fontSize: 13, maxWidth: 400 }}>
              Work with AI side by side. Review changes together,
              fix issues one by one, approve diffs before committing.
            </p>
          </div>

          {/* Suggested actions */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 500 }}>
            {[
              { icon: "🔍", text: "Review the auth module for security issues" },
              { icon: "🐛", text: "Fix the failing test in user.test.ts" },
              { icon: "♻️", text: "Refactor the database layer" },
            ].map((s) => (
              <button
                key={s.text}
                onClick={() => setInput(s.text)}
                style={{
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
                placeholder="Ask anything, @ to mention files..."
                style={{
                  flex: 1, padding: "8px 4px", border: "none",
                  background: "transparent", color: "#eee", fontSize: 14, outline: "none",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                style={{
                  width: 36, height: 36, borderRadius: 8, border: "none",
                  background: input.trim() ? "#2563eb" : "#222",
                  color: input.trim() ? "#fff" : "#555",
                  cursor: input.trim() ? "pointer" : "default",
                  fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                ↑
              </button>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 6, paddingLeft: 4 }}>
              <span style={{ fontSize: 10, color: "#444" }}>@ files</span>
              <span style={{ fontSize: 10, color: "#444" }}>/ commands</span>
              <span style={{ fontSize: 10, color: "#444" }}>$ skills</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Chat state
  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* Chat panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              marginBottom: 16, padding: "12px 16px", borderRadius: 12,
              background: msg.role === "user" ? "#111" : "transparent",
              borderLeft: msg.role === "assistant" ? "2px solid #2563eb" : "none",
            }}>
              <div style={{ fontSize: 11, color: "#555", marginBottom: 4, fontWeight: 600 }}>
                {msg.role === "user" ? "You" : "AI"}
              </div>
              <div style={{
                fontSize: 13, color: msg.role === "user" ? "#eee" : "#ccc",
                lineHeight: 1.6, whiteSpace: "pre-wrap",
                fontFamily: msg.role === "assistant" ? "'JetBrains Mono', 'Fira Code', monospace" : "inherit",
              }}>
                {msg.content}
              </div>
            </div>
          ))}
          {streaming && <ThinkingSpinner />}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={{ padding: "12px 24px 16px", borderTop: "1px solid #1a1a1a" }}>
          <div style={{
            display: "flex", gap: 8, padding: "8px 12px",
            background: "#0d0d0d", borderRadius: 12, border: "1px solid #222",
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={streaming ? "AI is working..." : "Continue the conversation..."}
              disabled={streaming}
              style={{
                flex: 1, padding: "8px 4px", border: "none",
                background: "transparent", color: "#eee", fontSize: 13, outline: "none",
              }}
            />
            <button
              onClick={sendMessage}
              disabled={streaming || !input.trim()}
              style={{
                width: 32, height: 32, borderRadius: 8, border: "none",
                background: !streaming && input.trim() ? "#2563eb" : "#222",
                color: !streaming && input.trim() ? "#fff" : "#555",
                cursor: !streaming && input.trim() ? "pointer" : "default",
                fontSize: 14,
              }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>

      {/* Diff panel (right) */}
      {showDiff && (
        <DiffPanel diffs={diffs} onClose={() => setShowDiff(false)} />
      )}

      {/* Toggle diff panel */}
      {!showDiff && diffs.length > 0 && (
        <button
          onClick={() => setShowDiff(true)}
          style={{
            position: "absolute", right: 16, top: 60,
            padding: "6px 12px", borderRadius: 8, border: "1px solid #333",
            background: "#111", color: "#888", cursor: "pointer", fontSize: 11,
          }}
        >
          Show Diff ({diffs.length})
        </button>
      )}
    </div>
  );
}
