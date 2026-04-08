import React, { useState, useRef, useEffect, useCallback } from "react";
import Pipeline from "./Pipeline";
import TaskLog from "./TaskLog";
import ProgressLoader, { IndeterminateLoader, InlineProgress, useFunMessages, usePipelineProgress } from "./ProgressLoader";
import type { Thread, Mode } from "../App";

type Props = {
  activeThread: Thread | null;
  workingDir: string;
  setWorkingDir: (dir: string) => void;
  createThread: (name: string, mode: Mode) => string;
  updateThreadEvents: (threadId: string, events: any[]) => void;
  appendThreadEvent: (threadId: string, event: any) => void;
  setThreadRunning: (threadId: string, running: boolean) => void;
};

type QuestionItem = {
  question: string;
  options: string[];
};

type PlanData = {
  plan: string;
  scope: { modify: string[]; create: string[]; do_not_touch: string[] };
  done_when: string[];
  approach: string;
};

type ClarificationState = {
  questions: QuestionItem[];
  answers: string[];
  intakeAnalysis: Record<string, any>;
};

type PlanState = {
  plan: PlanData;
  intakeAnalysis: Record<string, any>;
  answers: string[];
  previousClarification: ClarificationState | null;
};

// Per-thread UI state (not stored in Thread object)
type ThreadUIState = {
  task: string;
  clarification: ClarificationState | null;
  planReview: PlanState | null;
  intakeLoading: boolean;
  provider: "codex" | "debate";
};

const DEFAULT_UI_STATE: ThreadUIState = {
  task: "",
  clarification: null,
  planReview: null,
  intakeLoading: false,
  provider: "codex",
};

type HarnessStatus = {
  total: number;
  passing: boolean;
  missing: string[];
  checking: boolean;
};

export default function AGIMode({ activeThread, workingDir, setWorkingDir, createThread, updateThreadEvents, appendThreadEvent, setThreadRunning }: Props) {
  // Current UI state (for active thread or new-thread view)
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<"codex" | "debate">("codex");
  const [clarification, setClarification] = useState<ClarificationState | null>(null);
  const [planReview, setPlanReview] = useState<PlanState | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);

  // Progress hooks
  const intakeFunText = useFunMessages(intakeLoading);
  const events = activeThread?.events || [];
  const pipelineProgress = usePipelineProgress(events);

  // Harness quality state (info only — setup happens in intake when Run is clicked)
  const [harness, setHarness] = useState<HarnessStatus>({ total: 0, passing: true, missing: [], checking: false });

  // Auto-check harness when workingDir changes
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

  // Per-thread persistent stores (survive thread switches)
  const uiStatesRef = useRef<Map<string, ThreadUIState>>(new Map());
  const wsRef = useRef<Map<string, WebSocket>>(new Map());
  const prevThreadIdRef = useRef<string | null>(null);

  // Derive running from the thread object (source of truth)
  const running = activeThread?.running ?? false;

  // Save current UI state for a thread
  const saveUIState = useCallback((threadId: string) => {
    uiStatesRef.current.set(threadId, {
      task,
      clarification,
      planReview,
      intakeLoading,
      provider,
    });
  }, [task, clarification, planReview, intakeLoading, provider]);

  // Restore UI state for a thread
  const restoreUIState = useCallback((threadId: string) => {
    const saved = uiStatesRef.current.get(threadId);
    if (saved) {
      setTask(saved.task);
      setClarification(saved.clarification);
      setPlanReview(saved.planReview);
      setIntakeLoading(saved.intakeLoading);
      setProvider(saved.provider);
    } else {
      setTask("");
      setClarification(null);
      setPlanReview(null);
      setIntakeLoading(false);
    }
  }, []);

  // Handle thread switch: save old state, restore new state
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    const newId = activeThread?.id ?? null;

    // Save previous thread's UI state
    if (prevId && prevId !== newId) {
      saveUIState(prevId);
    }

    // Restore new thread's UI state or reset for new-thread view
    if (newId) {
      restoreUIState(newId);
    } else {
      // New thread view: reset everything
      setTask("");
      setClarification(null);
      setPlanReview(null);
      setIntakeLoading(false);
    }

    prevThreadIdRef.current = newId;
  }, [activeThread?.id]);

  // Cleanup: close all WebSockets on unmount
  useEffect(() => {
    return () => {
      wsRef.current.forEach((ws) => {
        try { ws.close(); } catch {}
      });
    };
  }, []);

  // Ref to track which intake phase we're waiting for
  const intakePhaseRef = useRef<"phase1" | "phase2" | null>(null);
  const intakeAnswersRef = useRef<string[]>([]);
  const intakeClarificationRef = useRef<ClarificationState | null>(null);

  // Listen for intake results via WebSocket
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/events`);
    const intakeWsRef = { current: ws };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === "intake.done" && intakePhaseRef.current) {
          const data = event.data || {};

          if (intakePhaseRef.current === "phase1") {
            // Phase 1: show questions or skip to run
            const rawQ = data.clarification_questions || [];
            const questions: QuestionItem[] = rawQ.map((q: any) =>
              typeof q === "string" ? { question: q, options: [] } : q
            );

            if (questions.length > 0) {
              setClarification({
                questions,
                answers: questions.map(() => ""),
                intakeAnalysis: data.intake_analysis || {},
              });
            } else {
              startRun([]);
            }
            setIntakeLoading(false);
            intakePhaseRef.current = null;
          } else if (intakePhaseRef.current === "phase2") {
            // Phase 2: show plan or skip to run
            const analysis = data.intake_analysis || {};
            if (analysis.plan || analysis.done_when || analysis.scope) {
              setPlanReview({
                plan: {
                  plan: analysis.plan || "",
                  scope: analysis.scope || { modify: [], create: [], do_not_touch: [] },
                  done_when: analysis.done_when || [],
                  approach: analysis.approach || "",
                },
                intakeAnalysis: analysis,
                answers: intakeAnswersRef.current,
                previousClarification: intakeClarificationRef.current,
              });
              setIntakeLoading(false);
              intakePhaseRef.current = null;
              return;
            }
            // No plan in response — go straight to run
            setIntakeLoading(false);
            intakePhaseRef.current = null;
            startRun(intakeAnswersRef.current);
          }
        }

        if (event.type === "intake.error" && intakePhaseRef.current) {
          console.error("[AGI] Intake error:", event.data?.error);
          setIntakeLoading(false);
          intakePhaseRef.current = null;
        }
      } catch {}
    };

    return () => { ws.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 1: Run intake to get clarification questions (async — no blocking fetch)
  const startIntake = async () => {
    if (!task.trim() || running || intakeLoading) return;
    setIntakeLoading(true);
    intakePhaseRef.current = "phase1";

    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, working_dir: workingDir, provider }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      // Response is just {"status":"started"} — real data comes via WebSocket
    } catch (err) {
      console.error("[AGI] Intake request failed:", err);
      setIntakeLoading(false);
      intakePhaseRef.current = null;
    }
  };

  // Step 2: Generate plan from answers (async — no blocking fetch)
  const generatePlan = async (answers: string[]) => {
    const savedClarification = clarification;
    setClarification(null);
    setIntakeLoading(true);
    intakePhaseRef.current = "phase2";
    intakeAnswersRef.current = answers;
    intakeClarificationRef.current = savedClarification;

    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task, working_dir: workingDir, provider,
          clarification_answers: answers.filter((a) => a.trim()),
          clarification_questions: savedClarification?.questions || [],
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
    } catch {
      setIntakeLoading(false);
      intakePhaseRef.current = null;
      startRun(answers);
    }
  };

  // Step 3: Run pipeline (with or without answers)
  const startRun = async (answers: string[]) => {
    // Capture plan data before clearing state
    const savedIntakeAnalysis = planReview?.intakeAnalysis ?? null;
    setClarification(null);
    setPlanReview(null);

    const tid = createThread(task.slice(0, 60), "agi");
    setThreadRunning(tid, true);

    // Save UI state for this new thread
    uiStatesRef.current.set(tid, {
      task,
      clarification: null,
      planReview: null,
      intakeLoading: false,
      provider,
    });

    try {
      const healthCheck = await fetch("/api/health");
      if (!healthCheck.ok) throw new Error("Backend not responding");
    } catch {
      const errMsg = "Backend server not running. Start it with: openseed serve --port 8000";
      updateThreadEvents(tid, [{ type: "error", data: { message: errMsg } }]);
      setThreadRunning(tid, false);
      return;
    }

    try {
      const ws = new WebSocket(`ws://${location.host}/ws/events`);
      wsRef.current.set(tid, ws);

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          appendThreadEvent(tid, event);

          if (event.type === "pipeline.complete" || event.type === "pipeline.fail") {
            setThreadRunning(tid, false);
            wsRef.current.delete(tid);
            setTimeout(() => ws.close(), 1000);
          }
        } catch {}
      };
      ws.onerror = () => {
        setThreadRunning(tid, false);
        wsRef.current.delete(tid);
      };
      ws.onclose = () => {
        setThreadRunning(tid, false);
        wsRef.current.delete(tid);
      };

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
          intake_analysis: (savedIntakeAnalysis && typeof savedIntakeAnalysis === 'object' && savedIntakeAnalysis.plan) ? savedIntakeAnalysis : null,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const text = await res.text();
      if (text) {
        const data = JSON.parse(text);
        if (data.error) {
          appendThreadEvent(tid, { type: "error", data: { message: data.error } });
          setThreadRunning(tid, false);
          ws.close();
          wsRef.current.delete(tid);
        }
      }
    } catch (err) {
      appendThreadEvent(tid, { type: "error", data: { message: String(err) } });
      setThreadRunning(tid, false);
    }
  };

  // ── Clarification UI ──
  if (clarification) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 24px", overflowY: "auto" }}>
        <div style={{ width: "100%", maxWidth: 640 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🤔</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>Before I start...</h2>
            <p style={{ color: "#666", fontSize: 12 }}>
              I researched current trends and best practices. Pick the options that fit your needs.
            </p>
          </div>

          <div style={{
            width: "100%", padding: "10px 14px", borderRadius: 8,
            background: "#111", border: "1px solid #222", fontSize: 12, color: "#888", marginBottom: 20,
          }}>
            <span style={{ color: "#555", fontWeight: 600 }}>Task:</span> {task}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {clarification.questions.map((q, i) => (
              <div key={i} style={{
                padding: "14px 16px", borderRadius: 10,
                border: "1px solid #1a1a1a", background: "#0a0a0a",
              }}>
                <div style={{ fontSize: 13, color: "#ccc", lineHeight: 1.5, marginBottom: 10 }}>
                  <span style={{ color: "#2563eb", fontWeight: 700, marginRight: 6 }}>{i + 1}.</span>
                  {q.question}
                </div>

                {q.options.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                    {q.options.map((opt) => {
                      const isSelected = clarification.answers[i] === opt;
                      return (
                        <button
                          key={opt}
                          onClick={() => {
                            const newAnswers = [...clarification.answers];
                            newAnswers[i] = isSelected ? "" : opt;
                            setClarification({ ...clarification, answers: newAnswers });
                          }}
                          style={{
                            padding: "6px 12px", borderRadius: 6, fontSize: 11,
                            border: isSelected ? "1px solid #2563eb" : "1px solid #222",
                            background: isSelected ? "#1e3a5f" : "#111",
                            color: isSelected ? "#60a5fa" : "#999",
                            cursor: "pointer", transition: "all 0.15s",
                            textAlign: "left", lineHeight: 1.4,
                          }}
                          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.borderColor = "#333"; }}
                          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.borderColor = "#222"; }}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                )}

                <input
                  value={q.options.includes(clarification.answers[i]) ? "" : clarification.answers[i]}
                  onChange={(e) => {
                    const newAnswers = [...clarification.answers];
                    newAnswers[i] = e.target.value;
                    setClarification({ ...clarification, answers: newAnswers });
                  }}
                  placeholder={q.options.length > 0 ? "Or type a custom answer..." : "Your answer..."}
                  style={{
                    width: "100%", padding: "8px 12px", borderRadius: 6,
                    border: "1px solid #1a1a1a", background: "#111", color: "#eee",
                    fontSize: 12, outline: "none",
                  }}
                  onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
                  onBlur={(e) => e.currentTarget.style.borderColor = "#1a1a1a"}
                />
              </div>
            ))}
          </div>

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
              onClick={() => generatePlan(clarification.answers)}
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

  // ── Plan Review UI ──
  if (planReview) {
    const { plan } = planReview;
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 24px", overflowY: "auto" }}>
        <div style={{ width: "100%", maxWidth: 640 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 6px" }}>Execution Plan</h2>
            <p style={{ color: "#666", fontSize: 12 }}>Review the plan below. Approve to start the pipeline.</p>
          </div>

          {plan.approach && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "#111", border: "1px solid #222", marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#555", fontWeight: 600, marginBottom: 4 }}>APPROACH</div>
              <div style={{ fontSize: 13, color: "#ddd", lineHeight: 1.5 }}>{plan.approach}</div>
            </div>
          )}

          {plan.plan && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "#0a0a0a", border: "1px solid #1a1a1a", marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#555", fontWeight: 600, marginBottom: 8 }}>STEPS</div>
              <div style={{ fontSize: 12, color: "#ccc", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{plan.plan}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            {plan.scope.modify.length > 0 && (
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: "#111", border: "1px solid #1a1a1a" }}>
                <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 600, marginBottom: 6 }}>MODIFY</div>
                {plan.scope.modify.map((f) => (
                  <div key={f} style={{ fontSize: 11, color: "#888", fontFamily: "monospace", marginBottom: 2 }}>{f}</div>
                ))}
              </div>
            )}
            {plan.scope.create.length > 0 && (
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: "#111", border: "1px solid #1a1a1a" }}>
                <div style={{ fontSize: 10, color: "#4ade80", fontWeight: 600, marginBottom: 6 }}>CREATE</div>
                {plan.scope.create.map((f) => (
                  <div key={f} style={{ fontSize: 11, color: "#888", fontFamily: "monospace", marginBottom: 2 }}>{f}</div>
                ))}
              </div>
            )}
            {plan.scope.do_not_touch.length > 0 && (
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: "#111", border: "1px solid #1a1a1a" }}>
                <div style={{ fontSize: 10, color: "#f87171", fontWeight: 600, marginBottom: 6 }}>DO NOT TOUCH</div>
                {plan.scope.do_not_touch.map((f) => (
                  <div key={f} style={{ fontSize: 11, color: "#888", fontFamily: "monospace", marginBottom: 2 }}>{f}</div>
                ))}
              </div>
            )}
          </div>

          {plan.done_when.length > 0 && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "#0d1a0d", border: "1px solid #1a2e1a", marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#4ade80", fontWeight: 600, marginBottom: 8 }}>DONE WHEN</div>
              {plan.done_when.map((criterion, i) => (
                <div key={i} style={{ fontSize: 12, color: "#ccc", marginBottom: 4, display: "flex", gap: 6 }}>
                  <span style={{ color: "#4ade80" }}>&#x2610;</span> {criterion}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={() => { setClarification(planReview.previousClarification); setPlanReview(null); }}
              style={{
                padding: "10px 20px", borderRadius: 10, border: "1px solid #333",
                background: "transparent", color: "#888", cursor: "pointer",
                fontSize: 13, fontWeight: 600, transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#555"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#333"}
            >
              Back
            </button>
            <button
              onClick={() => startRun(planReview.answers)}
              style={{
                padding: "10px 24px", borderRadius: 10, border: "none",
                background: "#16a34a", color: "#fff", cursor: "pointer",
                fontSize: 13, fontWeight: 700, transition: "background 0.15s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = "#22c55e"}
              onMouseLeave={(e) => e.currentTarget.style.background = "#16a34a"}
            >
              Approve & Run →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Empty state (no thread selected) ──
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
          {(["codex", "debate"] as const).map((p) => (
            <button key={p} onClick={() => setProvider(p)} style={{
              padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: provider === p ? "1px solid #2563eb" : "1px solid #222",
              background: provider === p ? "#1e3a5f" : "#111",
              color: provider === p ? "#60a5fa" : "#666",
              transition: "all 0.15s",
            }}>
              {p === "codex" ? "🟢 Codex" : "⚡ Debate"}
            </button>
          ))}
        </div>

        {/* Harness quality banner (info only — setup runs when user clicks Run) */}
        {!harness.checking && !harness.passing && (
          <div style={{
            background: "#1a1207", border: "1px solid #854d0e", borderRadius: 10,
            padding: "12px 18px", maxWidth: 500, width: "100%",
          }}>
            <span style={{ color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>
              Harness: {harness.total}/100
            </span>
            <span style={{ color: "#a3a3a3", fontSize: 11, marginLeft: 8 }}>
              — will be set up when you run
            </span>
            <div style={{ color: "#a3a3a3", fontSize: 11, lineHeight: 1.5, marginTop: 6 }}>
              {harness.missing.slice(0, 4).map((m, i) => (
                <div key={i}>- {m}</div>
              ))}
            </div>
          </div>
        )}
        {!harness.checking && harness.passing && harness.total > 0 && (
          <div style={{ color: "#22c55e", fontSize: 12, fontWeight: 500 }}>
            Harness: {harness.total}/100
          </div>
        )}

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

  // Intake loading state — no real events, so indeterminate + fun messages
  if (intakeLoading) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "0 40px" }}>
        <IndeterminateLoader text={intakeFunText} size="lg" />
      </div>
    );
  }

  // ── Running / completed state ──
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 24px", overflow: "hidden" }}>
      {/* Pipeline progress */}
      <Pipeline events={events} />

      {/* Status badge with progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {running ? (
          <InlineProgress pct={pipelineProgress.pct} text={pipelineProgress.text} />
        ) : events.some((e: any) => e.type === "pipeline.complete") ? (
          <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>🏆 Pipeline complete — {events.length} events</span>
        ) : events.some((e: any) => e.type === "pipeline.fail") ? (
          <InlineProgress pct={100} text="Pipeline failed" failed />
        ) : null}
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
