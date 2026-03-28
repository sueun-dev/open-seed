import React, { useState, useEffect } from "react";

// Default config matching OpenSeedConfig pydantic model
const DEFAULT_CONFIG = {
  auth: {
    claude_keychain_service: "openseed-claude-oauth",
    openai_keychain_service: "openseed-openai-oauth",
  },
  brain: {
    checkpoint_dir: "~/.openseed/checkpoints",
    max_parallel_sends: 4,
  },
  claude: {
    cli_path: "",
    opus_model: "claude-opus-4-6",
    sonnet_model: "claude-sonnet-4-6",
    haiku_model: "claude-haiku-4-5",
    default_model: "claude-sonnet-4-6",
    max_context_tokens: 1000000,
    thinking_budget: 10000,
    max_turns: 20,
  },
  codex: {
    cli_path: "",
    auto_mode: true,
    max_parallel_agents: 3,
    sandbox_mode: "workspace-write",
    model: "gpt-5.4",
  },
  qa_gate: {
    agents_dir: "config/agents",
    active_agents: "reviewer,security-auditor,test-automator,performance-engineer,code-reviewer,architect-reviewer,qa-expert",
    synthesizer: "knowledge-synthesizer",
    block_on_critical: true,
    max_parallel_agents: 6,
    enforce_output_contract: true,
  },
  sentinel: {
    max_retries: 10,
    stagnation_threshold: 3,
    backoff_base_ms: 5000,
    backoff_max_ms: 160000,
    backoff_cap_exponent: 5,
    insight_enabled: true,
    continuation_cooldown_ms: 5000,
  },
  body: {
    channels: "git",
    webhook_url: "",
    git_auto_commit: true,
    git_auto_push: false,
    git_branch: "main",
    git_commit_prefix: "openseed:",
    cron_enabled: false,
    cron_store_path: "~/.openseed/cron/jobs.json",
    cron_retention_days: 30,
  },
  memory: {
    backend: "qdrant",
    qdrant_url: "http://localhost:6333",
    qdrant_collection: "openseed",
    pgvector_url: "postgresql://localhost/openseed",
    pgvector_collection: "openseed_memories",
    sqlite_path: "~/.openseed/memory.db",
    history_path: "~/.openseed/history.db",
    embedding_model: "text-embedding-3-small",
    embedding_dims: 1536,
  },
  logging: {
    level: "info",
    format: "text",
    file: "",
  },
};

type SectionKey = keyof typeof DEFAULT_CONFIG;

// Section metadata for display
const SECTIONS: { key: SectionKey; label: string; icon: string; description: string }[] = [
  { key: "auth", label: "Authentication", icon: "🔐", description: "OAuth keychain services for Claude and OpenAI" },
  { key: "brain", label: "Brain (Pipeline)", icon: "🧠", description: "LangGraph checkpoint and parallelism settings" },
  { key: "claude", label: "Claude", icon: "🟣", description: "Claude CLI models, context window, and turn limits" },
  { key: "codex", label: "Codex", icon: "🟢", description: "Codex CLI, sandbox mode, and parallelism" },
  { key: "qa_gate", label: "QA Gate", icon: "🔍", description: "Quality assurance agents and synthesis" },
  { key: "sentinel", label: "Sentinel", icon: "🛡", description: "Retry limits, stagnation detection, backoff" },
  { key: "body", label: "Deployment", icon: "🚀", description: "Git, cron, webhook deployment channels" },
  { key: "memory", label: "Memory", icon: "💾", description: "Vector store backend and embedding settings" },
  { key: "logging", label: "Logging", icon: "📋", description: "Log level, format, and output file" },
];

// Field metadata for descriptions and types
const FIELD_META: Record<string, { label: string; description: string; type?: string; options?: string[] }> = {
  // Auth
  "auth.claude_keychain_service": { label: "Claude Keychain Service", description: "macOS Keychain identifier for Claude OAuth token" },
  "auth.openai_keychain_service": { label: "OpenAI Keychain Service", description: "macOS Keychain identifier for OpenAI OAuth token" },
  // Brain
  "brain.checkpoint_dir": { label: "Checkpoint Directory", description: "Directory for LangGraph state checkpoints" },
  "brain.max_parallel_sends": { label: "Max Parallel Sends", description: "Maximum concurrent node executions in the pipeline", type: "number" },
  // Claude
  "claude.cli_path": { label: "CLI Path", description: "Path to Claude CLI binary. Leave empty for auto-detect" },
  "claude.opus_model": { label: "Opus Model", description: "Model ID for Opus tier" },
  "claude.sonnet_model": { label: "Sonnet Model", description: "Model ID for Sonnet tier" },
  "claude.haiku_model": { label: "Haiku Model", description: "Model ID for Haiku tier" },
  "claude.default_model": { label: "Default Model", description: "Model used when no specific tier is requested", options: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  "claude.max_context_tokens": { label: "Max Context Tokens", description: "Maximum token window size", type: "number" },
  "claude.thinking_budget": { label: "Thinking Budget", description: "Token budget for extended thinking", type: "number" },
  "claude.max_turns": { label: "Max Turns", description: "Maximum conversation turns per session", type: "number" },
  // Codex
  "codex.cli_path": { label: "CLI Path", description: "Path to Codex CLI binary. Leave empty for auto-detect" },
  "codex.auto_mode": { label: "Full Auto Mode", description: "Run Codex with --full-auto flag", type: "boolean" },
  "codex.max_parallel_agents": { label: "Max Parallel Agents", description: "Maximum concurrent Codex agent processes", type: "number" },
  "codex.sandbox_mode": { label: "Sandbox Mode", description: "Codex sandbox isolation level", options: ["workspace-write", "workspace-read", "none"] },
  "codex.model": { label: "Model", description: "OpenAI model for Codex" },
  // QA Gate
  "qa_gate.agents_dir": { label: "Agents Directory", description: "Path to QA agent TOML configurations" },
  "qa_gate.active_agents": { label: "Active Agents", description: "Comma-separated list of active QA agent names" },
  "qa_gate.synthesizer": { label: "Synthesizer Agent", description: "Agent responsible for synthesizing QA findings" },
  "qa_gate.block_on_critical": { label: "Block on Critical", description: "Block pipeline on critical QA findings", type: "boolean" },
  "qa_gate.max_parallel_agents": { label: "Max Parallel Agents", description: "Maximum concurrent QA agents", type: "number" },
  "qa_gate.enforce_output_contract": { label: "Enforce Output Contract", description: "Validate QA agent output format", type: "boolean" },
  // Sentinel
  "sentinel.max_retries": { label: "Max Retries", description: "Maximum retry attempts before giving up", type: "number" },
  "sentinel.stagnation_threshold": { label: "Stagnation Threshold", description: "Consecutive failures before stagnation detection", type: "number" },
  "sentinel.backoff_base_ms": { label: "Backoff Base (ms)", description: "Base delay for exponential backoff", type: "number" },
  "sentinel.backoff_max_ms": { label: "Backoff Max (ms)", description: "Maximum delay for exponential backoff", type: "number" },
  "sentinel.backoff_cap_exponent": { label: "Backoff Cap Exponent", description: "Exponent cap for backoff calculation", type: "number" },
  "sentinel.insight_enabled": { label: "Insight Mode", description: "Enable insight analysis on failures", type: "boolean" },
  "sentinel.continuation_cooldown_ms": { label: "Continuation Cooldown (ms)", description: "Minimum delay between continuation attempts", type: "number" },
  // Body
  "body.channels": { label: "Deploy Channels", description: "Comma-separated deployment channels" },
  "body.webhook_url": { label: "Webhook URL", description: "URL for webhook deployment notifications" },
  "body.git_auto_commit": { label: "Auto Commit", description: "Automatically commit changes after pipeline", type: "boolean" },
  "body.git_auto_push": { label: "Auto Push", description: "Automatically push commits to remote", type: "boolean" },
  "body.git_branch": { label: "Branch", description: "Target git branch for commits" },
  "body.git_commit_prefix": { label: "Commit Prefix", description: "Prefix added to all commit messages" },
  "body.cron_enabled": { label: "Cron Enabled", description: "Enable scheduled pipeline runs", type: "boolean" },
  "body.cron_store_path": { label: "Cron Store Path", description: "File path for cron job storage" },
  "body.cron_retention_days": { label: "Cron Retention (days)", description: "Days to retain cron job history", type: "number" },
  // Memory
  "memory.backend": { label: "Backend", description: "Vector store backend for memory", options: ["qdrant", "pgvector", "sqlite"] },
  "memory.qdrant_url": { label: "Qdrant URL", description: "Qdrant server connection URL" },
  "memory.qdrant_collection": { label: "Qdrant Collection", description: "Qdrant collection name" },
  "memory.pgvector_url": { label: "PgVector URL", description: "PostgreSQL connection string for pgvector" },
  "memory.pgvector_collection": { label: "PgVector Collection", description: "PostgreSQL table name for vectors" },
  "memory.sqlite_path": { label: "SQLite Path", description: "File path for SQLite memory database" },
  "memory.history_path": { label: "History Path", description: "File path for conversation history database" },
  "memory.embedding_model": { label: "Embedding Model", description: "Model used for text embeddings" },
  "memory.embedding_dims": { label: "Embedding Dimensions", description: "Dimensionality of embedding vectors", type: "number" },
  // Logging
  "logging.level": { label: "Log Level", description: "Minimum log level to capture", options: ["debug", "info", "warning", "error"] },
  "logging.format": { label: "Log Format", description: "Output format for log entries", options: ["json", "text"] },
  "logging.file": { label: "Log File", description: "File path for log output. Leave empty for stdout" },
};

type Props = {
  onClose: () => void;
};

export default function Settings({ onClose }: Props) {
  const [activeSection, setActiveSection] = useState<SectionKey>("claude");
  const [config, setConfig] = useState<Record<string, any>>(() => {
    try {
      const saved = localStorage.getItem("os_config");
      return saved ? JSON.parse(saved) : structuredClone(DEFAULT_CONFIG);
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  });
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [authStatus, setAuthStatus] = useState<{
    claude: { installed: boolean; authenticated: boolean; error: string | null };
    openai: { installed: boolean; authenticated: boolean; error: string | null };
  } | null>(null);
  const [authLoading, setAuthLoading] = useState<string | null>(null);

  // Check auth status on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/status");
        if (res.ok) setAuthStatus(await res.json());
      } catch {}
    })();
  }, []);

  const triggerLogin = async (provider: "claude" | "openai") => {
    setAuthLoading(provider);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        // Refresh auth status
        const statusRes = await fetch("/api/auth/status");
        if (statusRes.ok) setAuthStatus(await statusRes.json());
      }
    } catch {}
    setAuthLoading(null);
  };

  // Load config from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const data = await res.json();
          // Flatten nested body config
          const flat: Record<string, any> = {};
          for (const [section, vals] of Object.entries(data)) {
            if (section === "body") {
              const b = vals as any;
              flat.body = {
                channels: (b.channels || []).join(","),
                webhook_url: b.webhook_url || "",
                git_auto_commit: b.git?.auto_commit ?? true,
                git_auto_push: b.git?.auto_push ?? false,
                git_branch: b.git?.branch || "main",
                git_commit_prefix: b.git?.commit_prefix || "openseed:",
                cron_enabled: b.cron?.enabled ?? false,
                cron_store_path: b.cron?.store_path || "~/.openseed/cron/jobs.json",
                cron_retention_days: b.cron?.retention_days ?? 30,
              };
            } else if (section === "qa_gate") {
              const q = vals as any;
              flat.qa_gate = {
                ...q,
                active_agents: Array.isArray(q.active_agents) ? q.active_agents.join(",") : q.active_agents || "",
              };
            } else {
              flat[section] = vals;
            }
          }
          setConfig((prev) => ({ ...prev, ...flat }));
        }
      } catch {}
    })();
  }, []);

  const updateField = (section: string, field: string, value: any) => {
    setConfig((prev) => ({
      ...prev,
      [section]: { ...prev[section], [field]: value },
    }));
    setDirty(true);
  };

  const saveConfig = async () => {
    setSaving(true);
    localStorage.setItem("os_config", JSON.stringify(config));

    // Unflatten body config for backend
    const payload: Record<string, any> = {};
    for (const [section, vals] of Object.entries(config)) {
      if (section === "body") {
        const b = vals as any;
        payload.body = {
          channels: (b.channels || "git").split(",").map((s: string) => s.trim()),
          webhook_url: b.webhook_url || null,
          git: {
            auto_commit: b.git_auto_commit,
            auto_push: b.git_auto_push,
            branch: b.git_branch,
            commit_prefix: b.git_commit_prefix,
          },
          cron: {
            enabled: b.cron_enabled,
            store_path: b.cron_store_path,
            retention_days: b.cron_retention_days,
          },
        };
      } else if (section === "qa_gate") {
        const q = vals as any;
        payload.qa_gate = {
          ...q,
          active_agents: typeof q.active_agents === "string"
            ? q.active_agents.split(",").map((s: string) => s.trim())
            : q.active_agents,
        };
      } else {
        payload[section] = vals;
      }
    }

    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}

    setTimeout(() => {
      setSaving(false);
      setDirty(false);
    }, 300);
  };

  const resetSection = (section: SectionKey) => {
    setConfig((prev) => ({
      ...prev,
      [section]: structuredClone((DEFAULT_CONFIG as any)[section]),
    }));
    setDirty(true);
  };

  // Filter fields by search
  const matchesSearch = (section: string, field: string) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const meta = FIELD_META[`${section}.${field}`];
    return (
      field.toLowerCase().includes(q) ||
      (meta?.label || "").toLowerCase().includes(q) ||
      (meta?.description || "").toLowerCase().includes(q) ||
      section.toLowerCase().includes(q)
    );
  };

  // When searching, show all sections that have matching fields
  const filteredSections = search
    ? SECTIONS.filter((s) =>
        Object.keys(config[s.key] || {}).some((f) => matchesSearch(s.key, f))
      )
    : SECTIONS;

  const sectionsToRender = search ? filteredSections : [SECTIONS.find((s) => s.key === activeSection)!];

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        width: "min(1100px, 92vw)", height: "min(750px, 88vh)",
        background: "#1e1e1e", borderRadius: 12, border: "1px solid #333",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
      }} onClick={(e) => e.stopPropagation()}>
        {/* Title bar */}
        <div style={{
          height: 48, padding: "0 20px", display: "flex", alignItems: "center",
          justifyContent: "space-between", borderBottom: "1px solid #333", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#ccc" }}>Settings</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {dirty && (
              <button onClick={saveConfig} style={{
                padding: "5px 14px", borderRadius: 6, border: "none",
                background: "#2563eb", color: "#fff", fontSize: 12,
                fontWeight: 600, cursor: "pointer",
              }}>
                {saving ? "Saving..." : "Save"}
              </button>
            )}
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 6, border: "1px solid #444",
              background: "transparent", color: "#888", cursor: "pointer",
              fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              x
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div style={{ padding: "12px 20px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings..."
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: "1px solid #333", background: "#252525", color: "#ddd",
              fontSize: 13, outline: "none",
            }}
            onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
            onBlur={(e) => e.currentTarget.style.borderColor = "#333"}
          />
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Left nav */}
          <div style={{
            width: 220, borderRight: "1px solid #2a2a2a", overflowY: "auto",
            padding: "8px 0", flexShrink: 0,
          }}>
            {SECTIONS.map((s) => {
              const isActive = !search && activeSection === s.key;
              const hasMatch = search && filteredSections.some((fs) => fs.key === s.key);
              if (search && !hasMatch) return null;
              return (
                <button
                  key={s.key}
                  onClick={() => { setActiveSection(s.key); setSearch(""); }}
                  style={{
                    width: "100%", padding: "8px 16px", border: "none", textAlign: "left",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                    background: isActive ? "#2a2a2a" : "transparent",
                    borderLeft: isActive ? "2px solid #2563eb" : "2px solid transparent",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#252525"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ fontSize: 14 }}>{s.icon}</span>
                  <span style={{ fontSize: 12, color: isActive ? "#fff" : "#999", fontWeight: isActive ? 600 : 400 }}>
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
            {sectionsToRender.map((section) => {
              if (!section) return null;
              const sectionConfig = config[section.key] || {};
              const fields = Object.keys(sectionConfig).filter((f) => matchesSearch(section.key, f));

              return (
                <div key={section.key} style={{ marginBottom: search ? 32 : 0 }}>
                  {/* Section header */}
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    marginBottom: 20,
                  }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 18 }}>{section.icon}</span>
                        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#eee", margin: 0 }}>
                          {section.label}
                        </h2>
                      </div>
                      <p style={{ fontSize: 12, color: "#666", margin: 0 }}>{section.description}</p>
                    </div>
                    <button
                      onClick={() => resetSection(section.key)}
                      style={{
                        padding: "4px 10px", borderRadius: 5, border: "1px solid #333",
                        background: "transparent", color: "#666", cursor: "pointer",
                        fontSize: 11, transition: "border-color 0.15s",
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.borderColor = "#555"}
                      onMouseLeave={(e) => e.currentTarget.style.borderColor = "#333"}
                    >
                      Reset to defaults
                    </button>
                  </div>

                  {/* Auth connection cards */}
                  {section.key === "auth" && (
                    <div style={{ marginBottom: 20 }}>
                      {(["claude", "openai"] as const).map((provider) => {
                        const status = authStatus?.[provider];
                        const isConnected = status?.authenticated;
                        const isInstalled = status?.installed;
                        const loading = authLoading === provider;

                        return (
                          <div key={provider} style={{
                            padding: "16px 18px", borderRadius: 8, border: `1px solid ${isConnected ? "#1a3a1a" : "#2a2020"}`,
                            background: isConnected ? "#0d1a0d" : "#1a1212",
                            marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 22 }}>{provider === "claude" ? "🟣" : "🟢"}</span>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#ddd" }}>
                                  {provider === "claude" ? "Anthropic (Claude)" : "OpenAI (Codex)"}
                                </div>
                                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                                  {!authStatus ? "Checking..." :
                                    !isInstalled ? "CLI not installed" :
                                    isConnected ? "Connected via OAuth" :
                                    status?.error || "Not authenticated"}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {/* Status badge */}
                              {authStatus && (
                                <span style={{
                                  fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4,
                                  background: isConnected ? "#16a34a22" : "#dc262622",
                                  color: isConnected ? "#4ade80" : "#f87171",
                                }}>
                                  {isConnected ? "Connected" : isInstalled ? "Disconnected" : "Not Installed"}
                                </span>
                              )}
                              {/* Connect button */}
                              {isInstalled && !isConnected && (
                                <button
                                  onClick={() => triggerLogin(provider)}
                                  disabled={loading}
                                  style={{
                                    padding: "6px 14px", borderRadius: 6, border: "none",
                                    background: loading ? "#333" : "#2563eb",
                                    color: loading ? "#666" : "#fff",
                                    fontSize: 11, fontWeight: 600, cursor: loading ? "default" : "pointer",
                                    transition: "background 0.15s",
                                  }}
                                >
                                  {loading ? "Connecting..." : "Connect"}
                                </button>
                              )}
                              {!isInstalled && authStatus && (
                                <button
                                  onClick={() => {
                                    const cmd = provider === "claude"
                                      ? "npm install -g @anthropic-ai/claude-code"
                                      : "npm install -g @openai/codex";
                                    navigator.clipboard.writeText(cmd);
                                  }}
                                  style={{
                                    padding: "6px 14px", borderRadius: 6, border: "1px solid #333",
                                    background: "transparent", color: "#888",
                                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                                    transition: "border-color 0.15s",
                                  }}
                                  onMouseEnter={(e) => e.currentTarget.style.borderColor = "#555"}
                                  onMouseLeave={(e) => e.currentTarget.style.borderColor = "#333"}
                                  title={provider === "claude"
                                    ? "npm install -g @anthropic-ai/claude-code"
                                    : "npm install -g @openai/codex"}
                                >
                                  Copy Install Command
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Fields */}
                  {fields.map((field) => {
                    const key = `${section.key}.${field}`;
                    const meta = FIELD_META[key];
                    const value = sectionConfig[field];
                    const defaultVal = (DEFAULT_CONFIG as any)[section.key]?.[field];
                    const isModified = JSON.stringify(value) !== JSON.stringify(defaultVal);

                    return (
                      <div key={key} style={{
                        padding: "14px 0", borderBottom: "1px solid #1a1a1a",
                        display: "flex", gap: 20,
                      }}>
                        {/* Label + description */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                            <span style={{
                              fontSize: 13, color: "#ddd", fontWeight: 500,
                              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                            }}>
                              {meta?.label || field}
                            </span>
                            {isModified && (
                              <span style={{
                                fontSize: 9, color: "#2563eb", background: "#1e3a5f",
                                padding: "1px 5px", borderRadius: 3, fontWeight: 600,
                              }}>
                                modified
                              </span>
                            )}
                          </div>
                          <p style={{ fontSize: 11, color: "#666", margin: 0, lineHeight: 1.4 }}>
                            {meta?.description || ""}
                          </p>
                          <span style={{
                            fontSize: 10, color: "#444", fontFamily: "monospace",
                          }}>
                            {section.key}.{field}
                          </span>
                        </div>

                        {/* Input */}
                        <div style={{ width: 280, flexShrink: 0 }}>
                          {renderInput(section.key, field, value, meta, updateField)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Render the appropriate input for a field
function renderInput(
  section: string,
  field: string,
  value: any,
  meta: { label: string; description: string; type?: string; options?: string[] } | undefined,
  onChange: (section: string, field: string, value: any) => void,
) {
  // Dropdown for options
  if (meta?.options) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(section, field, e.target.value)}
        style={{
          width: "100%", padding: "7px 10px", borderRadius: 5,
          border: "1px solid #333", background: "#252525", color: "#ddd",
          fontSize: 12, outline: "none", cursor: "pointer",
        }}
      >
        {meta.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }

  // Toggle for booleans
  if (meta?.type === "boolean" || typeof value === "boolean") {
    return (
      <button
        onClick={() => onChange(section, field, !value)}
        style={{
          width: 44, height: 24, borderRadius: 12, border: "none",
          background: value ? "#2563eb" : "#333", cursor: "pointer",
          position: "relative", transition: "background 0.15s",
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: 9,
          background: "#fff", position: "absolute", top: 3,
          left: value ? 23 : 3, transition: "left 0.15s",
        }} />
      </button>
    );
  }

  // Number input
  if (meta?.type === "number" || typeof value === "number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(section, field, Number(e.target.value))}
        style={{
          width: "100%", padding: "7px 10px", borderRadius: 5,
          border: "1px solid #333", background: "#252525", color: "#ddd",
          fontSize: 12, outline: "none", fontFamily: "monospace",
        }}
        onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
        onBlur={(e) => e.currentTarget.style.borderColor = "#333"}
      />
    );
  }

  // Text input (default)
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(section, field, e.target.value)}
      placeholder={meta?.label || field}
      style={{
        width: "100%", padding: "7px 10px", borderRadius: 5,
        border: "1px solid #333", background: "#252525", color: "#ddd",
        fontSize: 12, outline: "none", fontFamily: "monospace",
      }}
      onFocus={(e) => e.currentTarget.style.borderColor = "#2563eb"}
      onBlur={(e) => e.currentTarget.style.borderColor = "#333"}
    />
  );
}
