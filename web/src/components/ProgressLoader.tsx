import React, { useState, useEffect } from "react";

// ── 120+ random fun messages ────────────────────────────────────────────────

const FUN_MESSAGES = [
  "Cooking up some code...", "Simmering the algorithms...", "Adding a pinch of logic...",
  "Marinating the variables...", "Flambeing the functions...", "Whisking the dependencies...",
  "Letting it slow-cook...", "Seasoning with best practices...", "Kneading the architecture...",
  "Reducing the complexity sauce...",
  "Forging the codebase...", "Hammering out the details...", "Polishing every edge...",
  "Sharpening the algorithms...", "Welding components together...", "Sculpting the UI...",
  "Chiseling away bugs...", "Threading the needle...", "Weaving the logic...",
  "Spinning up the threads...",
  "Launching into orbit...", "Calculating trajectory...", "Docking with the API...",
  "Deploying satellite modules...", "Scanning the code galaxy...", "Warp drive engaged...",
  "Houston, we have progress...", "Refueling the engines...", "Navigating the codeverse...",
  "Entering hyperspace...",
  "Loading next level...", "Respawning variables...", "Boss fight with bugs...",
  "Collecting power-ups...", "Unlocking achievements...", "Speed running the build...",
  "Grinding XP points...", "Leveling up the codebase...", "Finding hidden Easter eggs...",
  "Equipping the best tools...",
  "Brewing fresh coffee...", "Taking a sip of espresso...", "Refilling the caffeine tank...",
  "Stretching before the sprint...", "Doing a quick meditation...", "Playing lo-fi beats...",
  "Petting the rubber duck...", "Adjusting the standing desk...", "Opening another tab...",
  "Closing 47 unused tabs...",
  "Dramatically staring at the code...", "Having an existential moment...",
  "Questioning all life choices...", "Pretending to look busy...",
  "Writing a resignation letter... just kidding", "Googling 'how to code'...",
  "Asking StackOverflow... wait, I'm the AI", "Reading the docs (for once)...",
  "Copy-pasting from the future...", "Time traveling to find the fix...",
  "Splitting atoms of logic...", "Running quantum calculations...",
  "Synthesizing the solution...", "Analyzing under the microscope...",
  "Mixing the perfect formula...", "Calibrating the instruments...",
  "Hypothesizing aggressively...", "Peer-reviewing itself...",
  "Publishing groundbreaking code...", "Winning a Nobel in debugging...",
  "Teaching a duck to debug...", "Herding cats (threads)...",
  "Training a code monkey...", "Feeding the server hamsters...",
  "Waking up the lazy functions...", "Walking the code dog...",
  "Counting electric sheep...", "Taming wild dependencies...",
  "Befriending a bug... then squashing it", "Riding a unicorn to production...",
  "Dalgona coding challenge...", "Bibimbapping the components...",
  "Kimchi-fermenting the build...", "K-pop dancing through the logic...",
  "Eating tteokbokki while compiling...", "Doing aegyo to the compiler...",
  "PC bang all-nighter mode...", "Drinking soju with the debugger...",
  "Running faster than KTX...", "Noraebang singing to the code...",
  "Attending a meeting about meetings...", "Sending a Slack that could've been a thought...",
  "Updating the Jira ticket...", "Writing a PR description longer than the code...",
  "Rebasing on main... pray for me...", "Resolving merge conflicts peacefully...",
  "Deleting node_modules (again)...", "Running npm install (the eternal ritual)...",
  "Waiting for CI... oh wait, I AM the CI...", "Making the linter happy...",
  "Doing push-ups between deploys...", "Practicing origami with the code...",
  "Building a house of cards (components)...", "Juggling 17 async tasks...",
  "Breakdancing on the event loop...", "Doing magic tricks with data...",
  "Bending spoons with pure logic...", "Teleporting between files...",
  "Summoning the code spirits...", "Consulting the Oracle (docs)...",
  "You're doing great, keep waiting...", "Rome wasn't built in one tick...",
  "Good things take time...", "Almost legendary...",
  "Trust the process...", "We're getting somewhere...",
  "This is going to be worth it...", "The best code is yet to come...",
  "Patience is a superpower...", "Your future self will thank you...",
  "Downloading more RAM...", "Reticulating splines...",
  "Constructing additional pylons...", "Compiling the meaning of life...",
  "Asking ChatGPT... wait, I AM the AI...", "Rebooting the matrix...",
  "Defragmenting the cloud...", "Updating Adobe Flash... just kidding...",
  "Translating binary to poetry...", "Negotiating with the compiler...",
];

function getRandomFun(): string {
  return FUN_MESSAGES[Math.floor(Math.random() * FUN_MESSAGES.length)];
}

// ── Pipeline event → real progress mapping ──────────────────────────────────

const PIPELINE_EVENTS: Record<string, { pct: number; text: string }> = {
  "node.start:intake":          { pct: 5,  text: "Understanding your task..." },
  "intake.context":             { pct: 8,  text: "Scanning codebase..." },
  "intake.harness":             { pct: 12, text: "Checking project harness..." },
  "intake.harness.setup":       { pct: 15, text: "Setting up harness..." },
  "intake.harness.done":        { pct: 18, text: "Harness ready!" },
  "intake.plan":                { pct: 20, text: "Generating plan..." },
  "node.complete:intake":       { pct: 22, text: "Intake complete!" },
  "node.start:plan":            { pct: 25, text: "Structuring the plan..." },
  "plan.convert":               { pct: 28, text: "Converting to task list..." },
  "plan.generate":              { pct: 30, text: "Designing architecture..." },
  "node.complete:plan":         { pct: 32, text: "Plan locked in!" },
  "node.start:implement":       { pct: 35, text: "Starting implementation..." },
  "implement.routing":          { pct: 38, text: "Assigning specialists..." },
  "implement.specialists":      { pct: 40, text: "Specialists are coding..." },
  "implement.specialist_start": { pct: 42, text: "Specialist working..." },
  "implement.specialist_done":  { pct: 55, text: "Specialist delivered!" },
  "implement.integration":      { pct: 60, text: "Integrating pieces..." },
  "implement.integration_done": { pct: 63, text: "Integration passed!" },
  "implement.verify":           { pct: 65, text: "Running lint checks..." },
  "implement.done":             { pct: 68, text: "Code is ready!" },
  "node.start:qa_gate":         { pct: 70, text: "QA reviewing..." },
  "node.complete:qa_gate":      { pct: 78, text: "QA complete!" },
  "node.start:sentinel":        { pct: 80, text: "Sentinel verifying..." },
  "node.retry":                 { pct: 82, text: "Fixing issues..." },
  "node.complete:sentinel":     { pct: 88, text: "All checks passed!" },
  "node.start:deploy":          { pct: 90, text: "Deploying..." },
  "node.complete:deploy":       { pct: 93, text: "Deployed!" },
  "node.start:memorize":        { pct: 95, text: "Saving lessons..." },
  "node.complete:memorize":     { pct: 98, text: "Memories stored!" },
  "pipeline.complete":          { pct: 100, text: "Done! Zero bugs." },
  "pipeline.fail":              { pct: 100, text: "Pipeline failed" },
};

// ── Hook: Cycling fun messages (no fake percentage) ─────────────────────────

export function useFunMessages(active: boolean) {
  const [text, setText] = useState(getRandomFun());

  useEffect(() => {
    if (!active) return;
    setText(getRandomFun());
    const interval = setInterval(() => setText(getRandomFun()), 2500);
    return () => clearInterval(interval);
  }, [active]);

  return text;
}

// ── Hook: Real event-driven pipeline progress ───────────────────────────────

export function usePipelineProgress(events: any[]) {
  const [pct, setPct] = useState(0);
  const [stageText, setStageText] = useState("Starting...");
  const [failed, setFailed] = useState(false);
  const [funText, setFunText] = useState(getRandomFun());
  const [showFun, setShowFun] = useState(false);

  useEffect(() => {
    if (!events.length) return;

    let maxPct = 0;
    let lastText = "Starting...";

    for (const event of events) {
      const type = event.type || "";
      const node = event.data?.node || event.node || "";
      const matched = PIPELINE_EVENTS[`${type}:${node}`] || PIPELINE_EVENTS[type];
      if (matched && matched.pct >= maxPct) {
        maxPct = matched.pct;
        lastText = matched.text;
      }
      if (type === "pipeline.fail") setFailed(true);
    }

    setPct(maxPct);
    setStageText(lastText);
  }, [events]);

  // Cycle fun messages between real stage updates
  useEffect(() => {
    if (pct >= 100 || failed) return;
    const interval = setInterval(() => {
      setShowFun((prev) => {
        if (!prev) setFunText(getRandomFun());
        return !prev;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [pct, failed]);

  return { pct, text: showFun && pct < 100 ? funText : stageText, failed };
}

// ── Component: Indeterminate loader (no percentage, just vibes) ─────────────

export function IndeterminateLoader({
  text,
  size = "md",
}: {
  text: string;
  size?: "sm" | "md" | "lg";
}) {
  const barHeight = size === "sm" ? 3 : size === "lg" ? 6 : 4;
  const fontSize = size === "sm" ? 11 : size === "lg" ? 14 : 13;
  const maxWidth = size === "sm" ? 200 : 320;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size === "sm" ? 8 : 14, width: "100%" }}>
      {/* Indeterminate animated bar */}
      <div style={{
        width: "100%",
        maxWidth,
        height: barHeight,
        background: "#1a1a1a",
        borderRadius: barHeight,
        overflow: "hidden",
        position: "relative",
      }}>
        <div style={{
          position: "absolute",
          width: "40%",
          height: "100%",
          background: "linear-gradient(90deg, transparent, #60a5fa, transparent)",
          borderRadius: barHeight,
          animation: "indeterminate 1.5s ease-in-out infinite",
        }} />
      </div>

      {/* Cycling text */}
      <div style={{ textAlign: "center", minHeight: size === "sm" ? 16 : 20 }}>
        <span style={{
          fontSize,
          color: "#888",
          fontWeight: 500,
          transition: "opacity 0.3s",
        }}>
          {text}
        </span>
      </div>
    </div>
  );
}

// ── Component: Real progress bar (event-driven, with percentage) ────────────

export default function ProgressLoader({
  pct,
  text,
  failed = false,
  size = "md",
}: {
  pct: number;
  text: string;
  failed?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const barHeight = size === "sm" ? 3 : size === "lg" ? 6 : 4;
  const fontSize = size === "sm" ? 11 : size === "lg" ? 14 : 13;
  const barColor = failed ? "#f87171" : pct >= 100 ? "#4ade80" : "#60a5fa";
  const glowColor = failed ? "rgba(248,113,113,0.3)" : pct >= 100 ? "rgba(74,222,128,0.3)" : "rgba(96,165,250,0.3)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size === "sm" ? 8 : 14, width: "100%" }}>
      {/* Progress bar */}
      <div style={{
        width: "100%",
        maxWidth: size === "sm" ? 200 : 320,
        height: barHeight,
        background: "#1a1a1a",
        borderRadius: barHeight,
        overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: barColor,
          borderRadius: barHeight,
          transition: "width 0.5s ease-out",
          boxShadow: `0 0 8px ${glowColor}`,
        }} />
      </div>

      {/* Text + percentage */}
      <div style={{ textAlign: "center", minHeight: size === "sm" ? 16 : 20 }}>
        <span style={{
          fontSize,
          color: failed ? "#f87171" : pct >= 100 ? "#4ade80" : "#888",
          fontWeight: 500,
        }}>
          {text}
        </span>
        <span style={{
          fontSize: fontSize - 1,
          color: failed ? "#f87171" : "#444",
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 600,
          marginLeft: 8,
        }}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

// ── Component: Inline progress for pipeline status badge ────────────────────

export function InlineProgress({
  pct,
  text,
  failed = false,
}: {
  pct: number;
  text: string;
  failed?: boolean;
}) {
  const barColor = failed ? "#f87171" : pct >= 100 ? "#4ade80" : "#60a5fa";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
      <div style={{
        width: 120, height: 3,
        background: "#1a1a1a", borderRadius: 3, overflow: "hidden", flexShrink: 0,
      }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: barColor, borderRadius: 3, transition: "width 0.5s ease-out",
        }} />
      </div>
      <span style={{ fontSize: 12, color: failed ? "#f87171" : "#60a5fa", fontWeight: 600 }}>
        {pct}% {text}
      </span>
    </div>
  );
}
