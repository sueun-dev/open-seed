import React, { useState, useRef, useEffect } from "react";
import Pipeline from "./Pipeline";
import TaskLog from "./TaskLog";
import { BrailleSpinner } from "./Spinner";
import type { Thread, Mode } from "../App";

type Props = {
  activeThread: Thread | null;
  workingDir: string;
  setWorkingDir: (dir: string) => void;
  createThread: (name: string, mode: Mode) => string;
  updateThreadEvents: (threadId: string, events: any[]) => void;
};

type ClarificationState = {
  questions: string[];
  answers: string[];
  intakeAnalysis: Record<string, any>;
};

export default function AGIMode({ activeThread, workingDir, setWorkingDir, createThread, updateThreadEvents }: Props) {
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>(activeThread?.events || []);
  const [provider, setProvider] = useState<"claude" | "codex" | "both">("claude");
  const [clarification, setClarification] = useState<ClarificationState | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const threadIdRef = useRef<string | null>(activeThread?.id || null);

  useEffect(() => {
    if (activeThread) {
      setEvents(activeThread.events);
      threadIdRef.current = activeThread.id;
    } else {
      setEvents([]);
      setTask("");
      setRunning(false);
      setClarification(null);
      setIntakeLoading(false);
      threadIdRef.current = null;
    }
  }, [activeThread?.id]);

  // Step 1: Run intake to get clarification questions
  const startIntake = async () => {
    if (!task.trim() || running || intakeLoading) return;
    setIntakeLoading(true);

    try {
      const healthCheck = await fetch("/api/health");
      if (!healthCheck.ok) throw new Error("Backend not responding");
    } catch {
      setIntakeLoading(false);
      setClarification(null);
      // Fallback: skip intake, go directly to run
      startRun([]);
      return;
    }

    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, working_dir: workingDir, provider }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      if (data.clarification_questions?.length > 0) {
        setClarification({
          questions: data.clarification_questions,
          answers: data.clarification_questions.map(() => ""),
          intakeAnalysis: data.intake_analysis || {},
        });
      } else {
        // No questions, run directly
        startRun([]);
      }
    } catch {
      // Fallback: run without clarification
      startRun([]);
    } finally {
      setIntakeLoading(false);
    }
  };

  // Step 2: Run pipeline (with or without answers)
  const startRun = async (answers: string[]) => {
    setClarification(null);
    setRunning(true);
    setEvents([]);

    const tid = createThread(task.slice(0, 60), "agi");
    threadIdRef.current = tid;

    try {
      const healthCheck = await fetch("/api/health");
      if (!healthCheck.ok) throw new Error("Backend not responding");
    } catch {
      const errMsg = "Backend server not running. Start it with: openseed serve --port 8000";
      setEvents((prev) => {
        const next = [...prev, { type: "error", data: { message: errMsg } }];
        updateThreadEvents(tid, next);
        return next;
      });
      setRunning(false);
      return;
    }

    try {
      const ws = new WebSocket(`ws://${location.host}/ws/events`);
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          setEvents((prev) => {
            const next = [...prev, event];
            updateThreadEvents(tid, next);
            return next;
          });
          if (event.type === "pipeline.complete" || event.type === "pipeline.fail") {
            setRunning(false);
            setTimeout(() => ws.close(), 1000);
          }
        } catch {}
      };
      ws.onerror = () => setRunning(false);
      ws.onclose = () => setRunning(false);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        setTimeout(resolve, 1000);
      });

      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task, working_dir: workingDir, provider,
          clarification_answers: answers.filter((a) => a.trim()),
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const text = await res.text();
      if (text) {
        const data = JSON.parse(text);
        if (data.error) {
          setEvents((prev) => [...prev, { type: "error", data: { message: data.error } }]);
          setRunning(false);
          ws.close();
        }
      }
    } catch (err) {
      setEvents((prev) => [...prev, { type: "error", data: { message: String(err) } }]);
      setRunning(false);
    }
  };

  // Clarification UI
  if (clarification) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 24px", overflowY: "auto" }}>
        <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🤔</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>Before I start...</h2>
          <p style={{ color: "#666", fontSize: 12, maxWidth: 500, margin: "0 auto" }}>
            I researched current trends and best practices. A few questions to nail down the approach.
          </p>
        </div>

        {/* Task summary */}
        <div style={{
          width: "100%", padding: "10px 14px", borderRadius: 8,
          background: "#111", border: "1px solid #222", fontSize: 12, color: "#888",
          marginBottom: 20,
        }}>
          <span style={{ color: "#555", fontWeight: 600 }}>Task:</span> {task}
        </div>

        {/* Questions */}
        {/* Questions */}
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
          {clarification.questions.map((q, i) => (
            <div key={i} style={{
              padding: "14px 16px", borderRadius: 10,
              border: "1px solid #1a1a1a", background: "#0a0a0a",
            }}>
              <div style={{
                fontSize: 13, color: "#ccc", lineHeight: 1.5,
                marginBottom: 10, whiteSpace: "pre-wrap",
              }}>
                <span style={{ color: "#2563eb", fontWeight: 700, marginRight: 6 }}>{i + 1}.</span>
                {q}
              </div>
              <input
                value={clarification.answers[i]}
                onChange={(e) => {
                  const newAnswers = [...clarification.answers];
                  newAnswers[i] = e.target.value;
                  setClarification({ ...clarification, answers: newAnswers });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && i === clarification.questions.length - 1) {
                    startRun(clarification.answers);
                  }
                }}
                placeholder="Your answer..."
                autoFocus={i === 0}
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: "1px solid #222", background: "#111", color: "#eee",
                  fontSize: 13, outline: "none",
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
                onBlur={(e) => e.currentTarget.style.borderColor = "#222"}
              />
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button
            onClick={() => startRun([])}
            style={{
              padding: "10px 20px", borderRadius: 10, border: "1px solid #333",
              background: "transparent", color: "#888", cursor: "pointer",
              fontSize: 13, fontWeight: 600, transition: "border-color 0.15s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.borderColor = "#555"}
            onMouseLeave={(e) => e.currentTarget.style.borderColor = "#333"}
          >
            Skip, just run
          </button>
          <button
            onClick={() => startRun(clarification.answers)}
            style={{
              padding: "10px 24px", borderRadius: 10, border: "none",
              background: "#2563eb", color: "#fff", cursor: "pointer",
              fontSize: 13, fontWeight: 700, transition: "background 0.15s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "#3b82f6"}
            onMouseLeave={(e) => e.currentTarget.style.background = "#2563eb"}
          >
            Continue →
          </button>
        </div>
      </div>
      </div>
    );
  }

  // Empty state
  if (!activeThread && events.length === 0 && !running && !intakeLoading) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>AGI Mode</h2>
          <p style={{ color: "#555", fontSize: 13, maxWidth: 400 }}>
            Describe what to build. The pipeline runs autonomously:
            intake, plan, implement, QA, fix, deploy, memorize.
          </p>
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
              {p === "claude" ? "🟣 Claude" : p === "codex" ? "🟢 Codex" : "⚡ Both"}
            </button>
          ))}
        </div>

        {/* Suggested tasks */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 600 }}>
          {[
            { icon: "🔨", text: "Build a REST API with auth and CRUD" },
            { icon: "🌐", text: "Create a React dashboard with charts" },
            { icon: "🐛", text: "Fix the login bug in auth.ts" },
          ].map((s) => (
            <button
              key={s.text}
              onClick={() => { setTask(s.text); }}
              style={{
                padding: "12px 16px", borderRadius: 10, border: "1px solid #222",
                background: "#111", color: "#999", cursor: "pointer", fontSize: 12,
                textAlign: "left", maxWidth: 200, transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#222"}
            >
              <span style={{ fontSize: 18, display: "block", marginBottom: 6 }}>{s.icon}</span>
              {s.text}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ width: "100%", maxWidth: 600, padding: "0 24px" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startIntake()}
              placeholder="Describe what to build..."
              style={{
                flex: 1, padding: "12px 16px", borderRadius: 10,
                border: "1px solid #222", background: "#111", color: "#eee",
                fontSize: 14, outline: "none",
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
              onBlur={(e) => e.currentTarget.style.borderColor = "#222"}
            />
            <button
              onClick={startIntake}
              disabled={!task.trim()}
              style={{
                padding: "12px 20px", borderRadius: 10, border: "none",
                background: task.trim() ? "#2563eb" : "#222",
                color: task.trim() ? "#fff" : "#555",
                fontWeight: 700, cursor: task.trim() ? "pointer" : "default",
                fontSize: 14, transition: "background 0.15s",
              }}
            >
              Run →
            </button>
          </div>
          <div style={{
            display: "flex", gap: 8, marginTop: 8, alignItems: "center",
          }}>
            <span style={{ fontSize: 11, color: "#444" }}>📁</span>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              style={{
                flex: 1, padding: "4px 8px", borderRadius: 6,
                border: "none", background: "transparent", color: "#555",
                fontSize: 11, outline: "none", fontFamily: "monospace",
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Intake loading state
  if (intakeLoading) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <div style={{ fontSize: 36 }}>🧠</div>
        <div style={{ fontSize: 14, color: "#60a5fa", fontWeight: 600 }}>
          <BrailleSpinner /> Analyzing your task...
        </div>
        <p style={{ color: "#555", fontSize: 12 }}>
          Scanning codebase, recalling memories, preparing questions
        </p>
      </div>
    );
  }

  // Running / completed state
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 24px", overflow: "hidden" }}>
      {/* Pipeline progress */}
      <Pipeline events={events} />

      {/* Status badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {running ? (
          <span style={{ fontSize: 12, color: "#60a5fa", fontWeight: 600 }}><BrailleSpinner /> Pipeline running...</span>
        ) : events.some((e) => e.type === "pipeline.complete") ? (
          <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>✓ Pipeline complete</span>
        ) : events.some((e) => e.type === "pipeline.fail") ? (
          <span style={{ fontSize: 12, color: "#f87171", fontWeight: 600 }}>✗ Pipeline failed</span>
        ) : null}
        <span style={{ fontSize: 11, color: "#444" }}>{events.length} events</span>
      </div>

      {/* Event log */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <TaskLog events={events} />
      </div>

      {/* Input for follow-up */}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && startIntake()}
          placeholder={running ? "Pipeline is running..." : "Run another task..."}
          disabled={running}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: "1px solid #222", background: "#0d0d0d", color: "#eee",
            fontSize: 13, outline: "none",
          }}
        />
        <button
          onClick={startIntake}
          disabled={running || !task.trim()}
          style={{
            padding: "10px 18px", borderRadius: 10, border: "none",
            background: running ? "#222" : "#2563eb", color: running ? "#555" : "#fff",
            fontWeight: 700, cursor: running ? "default" : "pointer", fontSize: 13,
          }}
        >
          {running ? "Running..." : "Run →"}
        </button>
      </div>
    </div>
  );
}
