import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ProjectAnalysis,
  TechStack,
  CommandMap,
  DirectoryStructure,
  ExistingConfig,
  MonorepoInfo,
  PackageInfo,
  CurationItem,
  LinterInfo,
} from "./types.js";

// ── Project Analyzer (Phase 1 Core) ────────────────────────

export function analyzeProject(projectRoot: string): ProjectAnalysis {
  const absRoot = path.resolve(projectRoot);

  if (!fs.existsSync(absRoot)) {
    throw new Error(`Project root does not exist: ${absRoot}`);
  }

  const pkgJson = readJsonSafe(path.join(absRoot, "package.json"));
  const tsconfigJson = readJsonSafe(path.join(absRoot, "tsconfig.json"));

  const techStack = detectTechStack(absRoot, pkgJson, tsconfigJson);
  const commands = detectCommands(absRoot, pkgJson, techStack);
  const structure = analyzeStructure(absRoot);
  const existingConfigs = detectExistingConfigs(absRoot);
  const monorepo = detectMonorepo(absRoot, pkgJson);
  const curationNeeded = identifyCurationNeeds(techStack, structure, monorepo);

  return {
    root: absRoot,
    name: pkgJson?.name ?? path.basename(absRoot),
    techStack,
    commands,
    structure,
    existingConfigs,
    monorepo,
    curationNeeded,
  };
}

// ── Tech Stack Detection ────────────────────────────────────

function detectTechStack(
  root: string,
  pkgJson: any,
  tsconfigJson: any
): TechStack {
  const deps = {
    ...pkgJson?.dependencies,
    ...pkgJson?.devDependencies,
  };

  const languages: string[] = [];
  const frameworks: string[] = [];

  // Languages
  if (tsconfigJson || deps?.typescript) languages.push("TypeScript");
  if (pkgJson && !deps?.typescript) languages.push("JavaScript");
  if (fileExists(root, "Cargo.toml")) languages.push("Rust");
  if (fileExists(root, "go.mod")) languages.push("Go");
  if (fileExists(root, "requirements.txt") || fileExists(root, "pyproject.toml") || fileExists(root, "setup.py"))
    languages.push("Python");
  if (fileExists(root, "Gemfile")) languages.push("Ruby");
  if (fileExists(root, "build.gradle") || fileExists(root, "pom.xml")) languages.push("Java");
  if (fileExists(root, "foundry.toml") || fileExists(root, "hardhat.config.ts") || fileExists(root, "hardhat.config.js"))
    languages.push("Solidity");

  // Frameworks
  if (deps?.next) frameworks.push(`Next.js`);
  if (deps?.react && !deps?.next) frameworks.push("React");
  if (deps?.vue) frameworks.push("Vue");
  if (deps?.svelte || deps?.["@sveltejs/kit"]) frameworks.push("Svelte");
  if (deps?.express) frameworks.push("Express");
  if (deps?.fastify) frameworks.push("Fastify");
  if (deps?.hono) frameworks.push("Hono");
  if (deps?.nestjs || deps?.["@nestjs/core"]) frameworks.push("NestJS");
  if (deps?.["@remix-run/node"] || deps?.["@remix-run/react"]) frameworks.push("Remix");
  if (deps?.nuxt) frameworks.push("Nuxt");
  if (deps?.astro) frameworks.push("Astro");
  if (deps?.vite && !frameworks.length) frameworks.push("Vite");
  if (deps?.hardhat) frameworks.push("Hardhat");
  if (fileExists(root, "foundry.toml")) frameworks.push("Foundry");
  if (deps?.django || deps?.flask) frameworks.push(deps?.django ? "Django" : "Flask");

  // Package manager
  const packageManager = detectPackageManager(root, pkgJson);

  // Node version
  const nodeVersion = pkgJson?.engines?.node ?? null;

  // Runtime
  let runtime: string | null = null;
  if (fileExists(root, "bun.lockb") || pkgJson?.devDependencies?.["bun-types"]) runtime = "Bun";
  else if (deps?.["@types/node"] || pkgJson) runtime = "Node.js";
  if (fileExists(root, "deno.json") || fileExists(root, "deno.jsonc")) runtime = "Deno";

  // Linter
  const linter = detectLinter(root, deps);

  // Formatter
  let formatter: string | null = null;
  if (deps?.prettier || fileExists(root, ".prettierrc") || fileExists(root, ".prettierrc.json"))
    formatter = "Prettier";
  if (deps?.["@biomejs/biome"] || fileExists(root, "biome.json") || fileExists(root, "biome.jsonc"))
    formatter = "Biome";
  if (fileExists(root, "rustfmt.toml") || fileExists(root, ".rustfmt.toml")) formatter = "rustfmt";
  if (deps?.["gofmt"]) formatter = "gofmt";

  // Test runner
  let testRunner: string | null = null;
  if (deps?.vitest) testRunner = "Vitest";
  else if (deps?.jest || deps?.["@jest/core"]) testRunner = "Jest";
  else if (deps?.mocha) testRunner = "Mocha";
  else if (deps?.["@playwright/test"]) testRunner = "Playwright";
  else if (deps?.cypress) testRunner = "Cypress";
  if (fileExists(root, "foundry.toml")) testRunner = testRunner ? `${testRunner} + Forge` : "Forge";
  if (deps?.pytest || fileExists(root, "pytest.ini")) testRunner = "pytest";

  // Build tool
  let buildTool: string | null = null;
  if (deps?.turbo || fileExists(root, "turbo.json")) buildTool = "Turborepo";
  else if (deps?.nx || fileExists(root, "nx.json")) buildTool = "Nx";
  else if (deps?.webpack) buildTool = "Webpack";
  else if (deps?.esbuild) buildTool = "esbuild";
  else if (deps?.rollup) buildTool = "Rollup";
  else if (deps?.tsup) buildTool = "tsup";
  else if (deps?.vite) buildTool = "Vite";
  if (fileExists(root, "Makefile")) buildTool = buildTool ? `${buildTool} + Make` : "Make";

  // Database
  let database: string | null = null;
  if (deps?.pg || deps?.postgres || deps?.["@neondatabase/serverless"]) database = "PostgreSQL";
  else if (deps?.mysql2) database = "MySQL";
  else if (deps?.mongodb || deps?.mongoose) database = "MongoDB";
  else if (deps?.["better-sqlite3"] || deps?.sqlite3) database = "SQLite";
  else if (deps?.redis || deps?.ioredis) database = "Redis";

  // ORM
  let orm: string | null = null;
  if (deps?.prisma || deps?.["@prisma/client"]) orm = "Prisma";
  else if (deps?.drizzle || deps?.["drizzle-orm"]) orm = "Drizzle";
  else if (deps?.typeorm) orm = "TypeORM";
  else if (deps?.sequelize) orm = "Sequelize";
  else if (deps?.knex) orm = "Knex";

  // CI/CD
  let cicd: string | null = null;
  if (fileExists(root, ".github/workflows")) cicd = "GitHub Actions";
  else if (fileExists(root, ".gitlab-ci.yml")) cicd = "GitLab CI";
  else if (fileExists(root, "Jenkinsfile")) cicd = "Jenkins";
  else if (fileExists(root, ".circleci")) cicd = "CircleCI";
  else if (fileExists(root, "Dockerfile")) cicd = cicd ? `${cicd} + Docker` : "Docker";

  return {
    languages,
    frameworks,
    packageManager,
    nodeVersion,
    runtime,
    linter,
    formatter,
    testRunner,
    buildTool,
    database,
    orm,
    cicd,
  };
}

function detectPackageManager(root: string, pkgJson: any): string | null {
  if (pkgJson?.packageManager) {
    const pm = pkgJson.packageManager as string;
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    if (pm.startsWith("bun")) return "bun";
    return "npm";
  }
  if (fileExists(root, "pnpm-lock.yaml") || fileExists(root, "pnpm-workspace.yaml")) return "pnpm";
  if (fileExists(root, "yarn.lock")) return "yarn";
  if (fileExists(root, "bun.lockb")) return "bun";
  if (fileExists(root, "package-lock.json")) return "npm";
  if (fileExists(root, "Cargo.toml")) return "cargo";
  if (fileExists(root, "go.mod")) return "go mod";
  if (fileExists(root, "pyproject.toml")) return "pip/uv";
  if (fileExists(root, "Pipfile")) return "pipenv";
  if (fileExists(root, "Gemfile")) return "bundler";
  return null;
}

function detectLinter(root: string, deps: Record<string, string>): LinterInfo | null {
  if (deps?.["@biomejs/biome"] || fileExists(root, "biome.json") || fileExists(root, "biome.jsonc")) {
    const configFile = fileExists(root, "biome.json") ? "biome.json" : "biome.jsonc";
    return { name: "Biome", configFile };
  }
  if (deps?.eslint || fileExists(root, ".eslintrc.json") || fileExists(root, ".eslintrc.js") || fileExists(root, "eslint.config.js") || fileExists(root, "eslint.config.mjs")) {
    const configs = [".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs"];
    const configFile = configs.find((c) => fileExists(root, c)) ?? "eslint.config.js";
    return { name: "ESLint", configFile };
  }
  if (fileExists(root, ".golangci.yml") || fileExists(root, ".golangci.yaml")) {
    return { name: "golangci-lint", configFile: ".golangci.yml" };
  }
  if (deps?.clippy || fileExists(root, "clippy.toml")) {
    return { name: "Clippy", configFile: "clippy.toml" };
  }
  if (deps?.pylint || deps?.ruff) {
    return { name: deps?.ruff ? "Ruff" : "Pylint", configFile: "pyproject.toml" };
  }
  return null;
}

// ── Command Detection ───────────────────────────────────────

function detectCommands(
  root: string,
  pkgJson: any,
  stack: TechStack
): CommandMap {
  const scripts = pkgJson?.scripts ?? {};
  const pm = stack.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;

  const commands: CommandMap = {
    install: null,
    build: null,
    dev: null,
    test: null,
    lint: null,
    typecheck: null,
    format: null,
    e2e: null,
    migrate: null,
  };

  // Install
  if (["pnpm", "yarn", "npm", "bun"].includes(pm)) commands.install = `${pm} install`;
  else if (pm === "cargo") commands.install = "cargo build";
  else if (pm === "go mod") commands.install = "go mod download";
  else if (pm === "pip/uv") commands.install = "pip install -r requirements.txt";

  // Map scripts
  const scriptMap: Record<string, keyof CommandMap> = {
    build: "build",
    dev: "dev",
    start: "dev",
    serve: "dev",
    test: "test",
    "test:unit": "test",
    lint: "lint",
    typecheck: "typecheck",
    "type-check": "typecheck",
    format: "format",
    "test:e2e": "e2e",
    "test:integration": "e2e",
    migrate: "migrate",
    "db:migrate": "migrate",
  };

  for (const [scriptName, commandKey] of Object.entries(scriptMap)) {
    if (scripts[scriptName] && !commands[commandKey]) {
      commands[commandKey] = `${run} ${scriptName}`;
    }
  }

  // Fallbacks for non-JS projects
  if (!commands.build && fileExists(root, "Makefile")) commands.build = "make build";
  if (!commands.build && fileExists(root, "Cargo.toml")) commands.build = "cargo build";
  if (!commands.build && fileExists(root, "go.mod")) commands.build = "go build ./...";

  if (!commands.test && fileExists(root, "Cargo.toml")) commands.test = "cargo test";
  if (!commands.test && fileExists(root, "go.mod")) commands.test = "go test ./...";
  if (!commands.test && fileExists(root, "foundry.toml")) commands.test = "forge test -vvv";
  if (!commands.test && fileExists(root, "pytest.ini")) commands.test = "pytest";

  if (!commands.lint && stack.linter) {
    if (stack.linter.name === "Biome") commands.lint = `${run} lint` in scripts ? `${run} lint` : "biome check .";
    if (stack.linter.name === "golangci-lint") commands.lint = "golangci-lint run";
    if (stack.linter.name === "Ruff") commands.lint = "ruff check .";
  }

  if (!commands.typecheck && stack.languages.includes("TypeScript")) {
    commands.typecheck = scripts.typecheck ? `${run} typecheck` : "tsc --noEmit";
  }

  return commands;
}

// ── Structure Analysis ──────────────────────────────────────

function analyzeStructure(root: string): DirectoryStructure {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const topLevel = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== "build")
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

  const notable: Record<string, string> = {};

  // Detect notable directories
  const notableDirs: Record<string, string> = {
    src: "application source code",
    lib: "library code",
    app: "application entry (Next.js/Remix)",
    api: "API routes/handlers",
    pages: "page components",
    components: "UI components",
    hooks: "React hooks",
    utils: "utility functions",
    helpers: "helper functions",
    types: "TypeScript type definitions",
    schemas: "validation schemas",
    models: "data models",
    services: "business logic services",
    repositories: "data access layer",
    middleware: "middleware functions",
    config: "configuration files",
    scripts: "dev/build scripts (not shipped)",
    docs: "documentation",
    test: "test files",
    tests: "test files",
    "__tests__": "test files",
    e2e: "end-to-end tests",
    fixtures: "test fixtures",
    migrations: "database migrations",
    prisma: "Prisma schema and migrations",
    public: "static assets",
    assets: "static assets",
    contracts: "smart contracts",
    deploy: "deployment scripts",
    infra: "infrastructure config",
    packages: "monorepo packages",
    apps: "monorepo applications",
  };

  for (const [dir, desc] of Object.entries(notableDirs)) {
    if (fs.existsSync(path.join(root, dir))) {
      notable[dir] = desc;
    }
  }

  // Detect source directory
  let sourceDir: string | null = null;
  for (const candidate of ["src", "lib", "app", "source"]) {
    if (fs.existsSync(path.join(root, candidate))) {
      sourceDir = candidate;
      break;
    }
  }

  return { topLevel, notable, sourceDir };
}

// ── Existing Config Detection ───────────────────────────────

function detectExistingConfigs(root: string): ExistingConfig[] {
  const configs: ExistingConfig[] = [];
  const checks: [string, string][] = [
    ["AGENTS.md", "agents-md"],
    ["CLAUDE.md", "claude-md"],
    [".cursorrules", "cursor-rules"],
    [".windsurfrules", "windsurf-rules"],
    [".github/copilot-instructions.md", "copilot-instructions"],
    ["CONTRIBUTING.md", "contributing"],
    ["README.md", "readme"],
    [".editorconfig", "editorconfig"],
    [".nvmrc", "nvmrc"],
    [".node-version", "node-version"],
    ["Dockerfile", "dockerfile"],
    ["docker-compose.yml", "docker-compose"],
    ["docker-compose.yaml", "docker-compose"],
  ];

  for (const [file, type] of checks) {
    if (fs.existsSync(path.join(root, file))) {
      configs.push({ type, path: file });
    }
  }

  return configs;
}

// ── Monorepo Detection ──────────────────────────────────────

function detectMonorepo(root: string, pkgJson: any): MonorepoInfo | null {
  let tool: string | null = null;
  let workspaceGlobs: string[] = [];

  if (fileExists(root, "turbo.json")) {
    tool = "Turborepo";
    workspaceGlobs = pkgJson?.workspaces ?? [];
  } else if (fileExists(root, "nx.json")) {
    tool = "Nx";
  } else if (fileExists(root, "lerna.json")) {
    tool = "Lerna";
  } else if (fileExists(root, "pnpm-workspace.yaml")) {
    tool = "pnpm workspaces";
    try {
      const wsContent = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf-8");
      const match = wsContent.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (match) {
        workspaceGlobs = match[1]
          .split("\n")
          .map((l) => l.trim().replace(/^-\s+/, "").replace(/['"]/g, ""))
          .filter(Boolean);
      }
    } catch {}
  } else if (pkgJson?.workspaces) {
    tool = "npm/yarn workspaces";
    workspaceGlobs = Array.isArray(pkgJson.workspaces)
      ? pkgJson.workspaces
      : pkgJson.workspaces.packages ?? [];
  }

  if (!tool) return null;

  // Resolve actual packages
  const packages: PackageInfo[] = [];
  const packageDirs = ["packages", "apps", "services", "libs", "modules"];

  for (const dir of packageDirs) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(dirPath, entry.name);
        const subPkgJson = readJsonSafe(path.join(pkgPath, "package.json"));
        packages.push({
          name: subPkgJson?.name ?? entry.name,
          path: `${dir}/${entry.name}`,
          description: subPkgJson?.description ?? inferPackageDescription(entry.name, dir),
        });
      }
    } catch {}
  }

  return { tool, packages };
}

function inferPackageDescription(name: string, parentDir: string): string {
  const hints: Record<string, string> = {
    web: "web frontend",
    app: "application",
    api: "API server",
    server: "backend server",
    core: "core business logic",
    shared: "shared utilities",
    common: "common utilities",
    types: "shared type definitions",
    ui: "UI component library",
    db: "database layer",
    config: "shared configuration",
    sdk: "SDK package",
    cli: "CLI tool",
    docs: "documentation site",
    auth: "authentication module",
  };
  return hints[name] ?? `${parentDir} package`;
}

// ── Curation Need Identification ────────────────────────────

function identifyCurationNeeds(
  stack: TechStack,
  structure: DirectoryStructure,
  monorepo: MonorepoInfo | null
): CurationItem[] {
  const items: CurationItem[] = [];

  // 1. Project mission (always needed)
  items.push({
    id: "mission",
    category: "context",
    question: "프로젝트를 한 문장으로 설명해주세요. (에이전트가 코드에서 추론할 수 없는 도메인 컨텍스트)",
    suggestions: [
      "SaaS platform for team collaboration",
      "E-commerce marketplace with real-time inventory",
      "Developer tools CLI for infrastructure management",
      "Mobile-first fintech application",
    ],
    required: true,
  });

  // 2. Core constraint
  items.push({
    id: "core-constraint",
    category: "architecture",
    question: "프로젝트의 핵심 아키텍처 제약이 있다면? (ex: offline-first, zero-trust, ACID compliance)",
    suggestions: [
      "Offline-first with CRDT sync",
      "Zero-trust security model",
      "Real-time with sub-100ms latency",
      "Multi-tenant data isolation",
      "없음",
    ],
    required: false,
  });

  // 3. Dependency flow (if monorepo)
  if (monorepo && monorepo.packages.length > 1) {
    const pkgNames = monorepo.packages.map((p) => p.name);
    items.push({
      id: "dependency-flow",
      category: "architecture",
      question: `모노레포 패키지 간 의존성 방향을 정의해주세요.\n감지된 패키지: ${pkgNames.join(", ")}`,
      suggestions: [
        `${pkgNames.join(" → ")} (왼쪽에서 오른쪽, 역방향 금지)`,
        "자유롭게 import 가능",
      ],
      required: true,
    });
  }

  // 4. Non-obvious patterns
  items.push({
    id: "non-obvious-patterns",
    category: "pattern",
    question: "코드에서 추론하기 어려운 비표준 패턴이 있다면? (ex: 특정 함수가 throw하지 않음, 특정 모듈만 DB 접근 가능)",
    suggestions: [
      "API client methods never throw; they return Result<T, E>",
      "All DB access goes through repository layer only",
      "Feature flags are resolved at startup, not runtime",
      "없음",
    ],
    required: false,
  });

  // 5. NEVER boundaries
  items.push({
    id: "never-boundaries",
    category: "judgment",
    question: "에이전트가 절대 하면 안 되는 것은? (기본값 외 추가할 것)",
    suggestions: [
      "Never modify generated/vendored files",
      "Never add dependencies without discussion",
      "Never disable linter rules inline",
      "Never use ORM raw queries",
      "기본값만 사용",
    ],
    required: false,
  });

  // 6. ASK boundaries
  items.push({
    id: "ask-boundaries",
    category: "judgment",
    question: "에이전트가 먼저 물어봐야 하는 것은?",
    suggestions: [
      "Before running database migrations",
      "Before adding new dependencies",
      "Before deleting files",
      "Before modifying CI/CD config",
      "기본값만 사용",
    ],
    required: false,
  });

  // 7. Error handling pattern
  items.push({
    id: "error-handling",
    category: "pattern",
    question: "에러 핸들링 패턴을 지정해주세요.",
    suggestions: [
      "Result<T, E> pattern (no throwing for expected failures)",
      "Domain-specific error classes with throw",
      "RFC 7807 Problem Details for API errors",
      "프로젝트에 맞게 AI가 추천",
    ],
    required: false,
  });

  // 8. Test coverage requirement
  if (stack.testRunner) {
    items.push({
      id: "test-coverage",
      category: "judgment",
      question: `테스트 커버리지 최소 요구사항은? (test runner: ${stack.testRunner})`,
      suggestions: ["80% line coverage", "90% line coverage", "100% branch coverage on core", "커버리지 요구 없음"],
      required: false,
    });
  }

  // 9. Persona
  items.push({
    id: "persona",
    category: "persona",
    question: "에이전트 페르소나를 설정할까요?",
    suggestions: [
      "Senior Backend Engineer",
      "Full-stack Developer",
      "Systems Engineer",
      "멀티 페르소나 (@Lead, @Dev, @Critic)",
      "페르소나 없음",
    ],
    required: false,
  });

  // 10. Git conventions
  items.push({
    id: "git-conventions",
    category: "judgment",
    question: "Git 커밋/PR 컨벤션은?",
    suggestions: [
      "Conventional Commits (feat/fix/refactor/test/docs/chore)",
      "Gitmoji",
      "Free-form",
      "AI가 추천",
    ],
    required: false,
  });

  return items;
}

// ── Utilities ───────────────────────────────────────────────

function readJsonSafe(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function fileExists(root: string, relativePath: string): boolean {
  return fs.existsSync(path.join(root, relativePath));
}
