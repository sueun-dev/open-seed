#!/usr/bin/env node

import { Command } from "commander";

import { runInitCommand } from "./commands/init.js";
import { runInitDeepCommand } from "./commands/init-deep.js";
import { runCheckCommentsCommand } from "./commands/check-comments.js";
import { runRunCommand } from "./commands/run.js";
import { runCreateCommand } from "./commands/create.js";
import { runTeamCommand } from "./commands/team.js";
import { runRalphLoopCommand, runStartWorkCommand, runRefactorCommand, runHandoffCommand, runStopContinuationCommand, runCancelRalphCommand } from "./commands/omo-commands.js";
import { runResumeCommand } from "./commands/resume.js";
import { runStatusCommand } from "./commands/status.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runSoakCommand } from "./commands/soak.js";
import { runMcpServer } from "./mcp/server.js";
import { runWorkerCommand } from "./orchestration/worker-runner.js";

const program = new Command();

program.name("agent").description("Terminal-first 40-role coding agent MVP");

program.command("init").description("Initialize .agent config").action(runInitCommand);

program.command("init-deep").description("Generate hierarchical AGENTS.md files for the repository").action(runInitDeepCommand);

program
  .command("create")
  .description("One-Prompt-to-App: build a complete app from a single prompt")
  .argument("<prompt>", "What to build (e.g. 'Todo 앱 만들어줘')")
  .action(runCreateCommand);

program
  .command("run")
  .description("Run a task through the orchestration loop")
  .argument("<task>", "Task to execute")
  .action(runRunCommand);

// Non-interactive mode (OpenCode -p flag)
program
  .command("prompt")
  .description("Run a single prompt non-interactively and exit (like OpenCode -p)")
  .argument("<task>", "Task to execute")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option("-q, --quiet", "Suppress progress output")
  .action(async (task: string, options: { format: string; quiet: boolean }) => {
    const { runRunCommand } = await import("./commands/run.js");
    // Set non-interactive env
    process.env.OPENSEED_NON_INTERACTIVE = "1";
    if (options.quiet) process.env.OPENSEED_QUIET = "1";
    if (options.format === "json") process.env.OPENSEED_OUTPUT_JSON = "1";
    await runRunCommand(task);
  });

program
  .command("team")
  .description("Run a task through the team worker runtime")
  .argument("<task>", "Task to execute")
  .action(runTeamCommand);

program
  .command("ralph-loop")
  .description("OMO: Run task in a loop until 100% complete")
  .argument("<task>", "Task to complete")
  .action(runRalphLoopCommand);

program
  .command("start-work")
  .description("OMO: Planning → Execution pipeline (Prometheus + Atlas)")
  .argument("<task>", "Task to plan and execute")
  .action(runStartWorkCommand);

program
  .command("refactor")
  .description("OMO: Safe refactoring with verification")
  .argument("<target>", "What to refactor")
  .action(runRefactorCommand);

program
  .command("handoff")
  .description("OMO: Generate context handoff document for session transfer")
  .action(runHandoffCommand);

program
  .command("stop")
  .description("OMO: Stop all continuation loops")
  .action(runStopContinuationCommand);

program
  .command("cancel-ralph")
  .description("OMO: Cancel active Ralph loop")
  .action(runCancelRalphCommand);

program
  .command("resume")
  .description("Resume a session")
  .argument("<sessionId>", "Session identifier")
  .action(runResumeCommand);

program
  .command("status")
  .description("Show session status")
  .argument("[sessionId]", "Optional session identifier")
  .action(runStatusCommand);

program.command("doctor").description("Run local environment checks").action(runDoctorCommand);

// OpenCode-style ask command (provider advisor)
program
  .command("ask")
  .description("Ask a specific provider for advice (non-interactive)")
  .argument("<provider>", "Provider: openai")
  .argument("<question>", "Question to ask")
  .action(async (provider: string, question: string) => {
    const { loadConfig } = await import("./core/config.js");
    const { ProviderRegistry } = await import("./providers/registry.js");
    const config = await loadConfig(process.cwd());
    const registry = new ProviderRegistry();
    try {
      const resp = await registry.invokeWithFailover(config, provider as any, {
        role: "researcher", category: "research", systemPrompt: "You are a helpful coding assistant. Answer concisely.",
        prompt: question, responseFormat: "text"
      });
      process.stdout.write(resp.text + "\n");
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  });

program
  .command("check-comments")
  .description("Scan source files for problematic comments (TODO, FIXME, commented-out code)")
  .option("--errors-only", "Only show errors, not warnings")
  .action(async (options: { errorsOnly?: boolean }) => {
    await runCheckCommentsCommand(options.errorsOnly);
  });

program
  .command("soak")
  .description("Run a parallel provider streaming soak test")
  .option("--providers <providers>", "Comma-separated provider list", "openai")
  .option("--rounds <count>", "Number of rounds per provider", "2")
  .option("--prompt <prompt>", "Override the soak prompt")
  .action(async (options: { providers: string; rounds: string; prompt?: string }) => {
    await runSoakCommand(options.providers, options.rounds, options.prompt);
  });

program
  .command("mcp")
  .description("Start the MCP (Model Context Protocol) server over stdio")
  .action(async () => {
    await runMcpServer();
  });

program
  .command("_worker")
  .description("Internal worker entrypoint")
  .requiredOption("--session <sessionId>", "Session ID")
  .requiredOption("--task <taskId>", "Task ID")
  .requiredOption("--role <role>", "Role ID")
  .requiredOption("--provider <provider>", "Provider ID")
  .requiredOption("--prompt-file <path>", "Prompt file path")
  .action(runWorkerCommand);

await program.parseAsync(process.argv);
