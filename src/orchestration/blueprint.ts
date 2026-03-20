/**
 * Blueprint Generator — Creates a complete app specification from discovery results.
 *
 * After the user answers discovery questions, this module generates a full
 * architectural blueprint that the orchestrator uses to build the app.
 *
 * Inspired by:
 * - Devin: autonomous project planning
 * - oh-my-openagent Sisyphus: structured delegation with evidence requirements
 * - MetaGPT: multi-role specification documents
 * - Plandex: plan-first execution with dependency tracking
 */

import type { DiscoveryResult, StackLayer, UserAnswer } from "./prompt-discovery.js";
import type { PlannerTask, RoleCategory } from "../core/types.js";

// ─── Blueprint Types ─────────────────────────────────────────────────────────

export interface FileSpec {
  path: string;
  description: string;
  /** Which blueprint phase creates this file */
  phase: BlueprintPhase;
  /** Dependencies — other files that must exist first */
  dependsOn?: string[];
  /** Template hint for the executor */
  templateHint?: string;
}

export interface SchemaEntity {
  name: string;
  fields: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    unique?: boolean;
    reference?: string;
  }>;
  description: string;
}

export interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  auth: boolean;
  requestBody?: string;
  responseType?: string;
}

export interface UiPage {
  path: string;
  name: string;
  description: string;
  components: string[];
  layout: "public" | "authenticated" | "admin";
}

export interface UiComponent {
  name: string;
  description: string;
  props?: string[];
  /** Whether this is a shared/reusable component */
  shared: boolean;
}

export type BlueprintPhase =
  | "scaffold"      // Project structure, config files, package.json
  | "schema"        // Database schema, types, interfaces
  | "backend"       // API routes, server logic, middleware
  | "frontend"      // Pages, components, layouts
  | "integration"   // Wiring frontend to backend, auth flows
  | "testing"       // Unit tests, integration tests, E2E
  | "polish"        // Error handling, loading states, edge cases
  | "verification"; // Build, lint, test, type-check

export interface BlueprintPhaseSpec {
  phase: BlueprintPhase;
  order: number;
  description: string;
  tasks: PlannerTask[];
  files: FileSpec[];
  /** Roles activated during this phase */
  roles: string[];
  /** Evidence required to pass this phase */
  evidence: string[];
  /** Estimated tool calls needed */
  estimatedToolCalls: number;
}

export interface AppBlueprint {
  /** Project name (derived from prompt) */
  name: string;
  /** One-line description */
  description: string;
  /** Full discovery result */
  discovery: DiscoveryResult;
  /** User answers to discovery questions */
  answers: UserAnswer[];
  /** Tech stack decisions */
  stack: Record<string, string>;
  /** Database schema (if applicable) */
  schema: SchemaEntity[];
  /** API endpoints (if applicable) */
  endpoints: ApiEndpoint[];
  /** UI pages (if applicable) */
  pages: UiPage[];
  /** UI components (if applicable) */
  components: UiComponent[];
  /** All files that will be created */
  files: FileSpec[];
  /** Execution phases in order */
  phases: BlueprintPhaseSpec[];
  /** Project directory structure */
  directoryStructure: string[];
  /** Package dependencies */
  dependencies: Record<string, string>;
  /** Dev dependencies */
  devDependencies: Record<string, string>;
  /** Environment variables needed */
  envVars: Array<{ key: string; description: string; required: boolean; example: string }>;
  /** Total estimated tasks */
  totalTasks: number;
  /** Total estimated files */
  totalFiles: number;
}

// ─── Blueprint Generation ────────────────────────────────────────────────────

export function generateBlueprint(
  discovery: DiscoveryResult,
  answers: UserAnswer[]
): AppBlueprint {
  const name = extractProjectName(discovery.originalPrompt);
  const description = discovery.inferredGoal;
  const layers = discovery.detectedLayers;
  const category = discovery.appCategory;

  const schema = buildSchema(discovery, answers);
  const endpoints = buildEndpoints(discovery, answers, schema);
  const pages = buildPages(discovery, answers);
  const components = buildComponents(discovery, answers, pages);
  const files = buildFileList(discovery, answers, schema, endpoints, pages, components);
  const phases = buildPhases(discovery, answers, files, schema, endpoints, pages, components);
  const directoryStructure = buildDirectoryStructure(files);
  const { dependencies, devDependencies } = buildDependencies(discovery);
  const envVars = buildEnvVars(discovery, answers);

  return {
    name,
    description,
    discovery,
    answers,
    stack: discovery.suggestedStack,
    schema,
    endpoints,
    pages,
    components,
    files,
    phases,
    directoryStructure,
    dependencies,
    devDependencies,
    envVars,
    totalTasks: phases.reduce((sum, p) => sum + p.tasks.length, 0),
    totalFiles: files.length,
  };
}

// ─── Project Name Extraction ─────────────────────────────────────────────────

function extractProjectName(prompt: string): string {
  // Try to extract a meaningful name
  const cleaned = prompt
    .replace(/\b(만들어줘|만들어|만들|해줘|해주세요|create|build|make|an?|the|나를? ?위한?|for me)\b/gi, "")
    .trim()
    .toLowerCase();

  // Take first meaningful words
  const words = cleaned.split(/\s+/).filter(w => w.length > 1).slice(0, 3);
  if (words.length === 0) return "my-app";

  return words.join("-").replace(/[^a-z0-9가-힣-]/g, "").slice(0, 30) || "my-app";
}

// ─── Schema Builder ──────────────────────────────────────────────────────────

function buildSchema(discovery: DiscoveryResult, answers: UserAnswer[]): SchemaEntity[] {
  const entities: SchemaEntity[] = [];
  const prompt = discovery.originalPrompt.toLowerCase();
  const hasAuth = discovery.detectedLayers.includes("auth");

  // User entity (if auth is needed)
  if (hasAuth) {
    entities.push({
      name: "User",
      description: "Registered user account",
      fields: [
        { name: "id", type: "uuid", unique: true },
        { name: "email", type: "string", unique: true },
        { name: "name", type: "string" },
        { name: "passwordHash", type: "string", nullable: true },
        { name: "avatarUrl", type: "string", nullable: true },
        { name: "provider", type: "string", nullable: true },
        { name: "providerId", type: "string", nullable: true },
        { name: "createdAt", type: "timestamp" },
        { name: "updatedAt", type: "timestamp" },
      ]
    });
  }

  // Domain-specific entities from prompt analysis
  if (/todo|할일|task|태스크/i.test(prompt)) {
    entities.push({
      name: "Todo",
      description: "A task/todo item",
      fields: [
        { name: "id", type: "uuid", unique: true },
        { name: "title", type: "string" },
        { name: "description", type: "string", nullable: true },
        { name: "completed", type: "boolean" },
        { name: "priority", type: "enum(low,medium,high)" },
        { name: "dueDate", type: "timestamp", nullable: true },
        ...(hasAuth ? [{ name: "userId", type: "uuid", reference: "User.id" }] : []),
        { name: "createdAt", type: "timestamp" },
        { name: "updatedAt", type: "timestamp" },
      ]
    });
  }

  if (/blog|블로그|post|게시/i.test(prompt)) {
    entities.push(
      {
        name: "Post",
        description: "Blog post or article",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "title", type: "string" },
          { name: "slug", type: "string", unique: true },
          { name: "content", type: "text" },
          { name: "excerpt", type: "string", nullable: true },
          { name: "published", type: "boolean" },
          { name: "publishedAt", type: "timestamp", nullable: true },
          ...(hasAuth ? [{ name: "authorId", type: "uuid", reference: "User.id" }] : []),
          { name: "createdAt", type: "timestamp" },
          { name: "updatedAt", type: "timestamp" },
        ]
      },
      {
        name: "Comment",
        description: "Comment on a post",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "content", type: "text" },
          { name: "postId", type: "uuid", reference: "Post.id" },
          ...(hasAuth ? [{ name: "authorId", type: "uuid", reference: "User.id" }] : []),
          { name: "createdAt", type: "timestamp" },
        ]
      }
    );
  }

  if (/shop|store|상점|쇼핑|commerce|상품|product/i.test(prompt)) {
    entities.push(
      {
        name: "Product",
        description: "Product listing",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "name", type: "string" },
          { name: "slug", type: "string", unique: true },
          { name: "description", type: "text" },
          { name: "price", type: "decimal" },
          { name: "imageUrl", type: "string", nullable: true },
          { name: "category", type: "string" },
          { name: "stock", type: "integer" },
          { name: "active", type: "boolean" },
          { name: "createdAt", type: "timestamp" },
        ]
      },
      {
        name: "Order",
        description: "Customer order",
        fields: [
          { name: "id", type: "uuid", unique: true },
          ...(hasAuth ? [{ name: "userId", type: "uuid", reference: "User.id" }] : []),
          { name: "status", type: "enum(pending,paid,shipped,delivered,cancelled)" },
          { name: "totalAmount", type: "decimal" },
          { name: "createdAt", type: "timestamp" },
          { name: "updatedAt", type: "timestamp" },
        ]
      },
      {
        name: "OrderItem",
        description: "Individual item in an order",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "orderId", type: "uuid", reference: "Order.id" },
          { name: "productId", type: "uuid", reference: "Product.id" },
          { name: "quantity", type: "integer" },
          { name: "unitPrice", type: "decimal" },
        ]
      }
    );
  }

  if (/chat|채팅|messag|메시지/i.test(prompt)) {
    entities.push(
      {
        name: "ChatRoom",
        description: "Chat room / conversation",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "name", type: "string" },
          { name: "type", type: "enum(direct,group)" },
          { name: "createdAt", type: "timestamp" },
        ]
      },
      {
        name: "Message",
        description: "Chat message",
        fields: [
          { name: "id", type: "uuid", unique: true },
          { name: "content", type: "text" },
          { name: "roomId", type: "uuid", reference: "ChatRoom.id" },
          ...(hasAuth ? [{ name: "senderId", type: "uuid", reference: "User.id" }] : []),
          { name: "createdAt", type: "timestamp" },
        ]
      }
    );
  }

  // If no domain entities were detected, create a generic Item entity
  if (entities.length === 0 || (entities.length === 1 && entities[0].name === "User")) {
    entities.push({
      name: "Item",
      description: "Primary data entity",
      fields: [
        { name: "id", type: "uuid", unique: true },
        { name: "title", type: "string" },
        { name: "description", type: "text", nullable: true },
        { name: "status", type: "string" },
        ...(hasAuth ? [{ name: "userId", type: "uuid", reference: "User.id" }] : []),
        { name: "createdAt", type: "timestamp" },
        { name: "updatedAt", type: "timestamp" },
      ]
    });
  }

  return entities;
}

// ─── API Endpoints Builder ───────────────────────────────────────────────────

function buildEndpoints(
  discovery: DiscoveryResult,
  _answers: UserAnswer[],
  schema: SchemaEntity[]
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const hasAuth = discovery.detectedLayers.includes("auth");

  if (hasAuth) {
    endpoints.push(
      { method: "POST", path: "/api/auth/register", description: "Register new user", auth: false, requestBody: "{ email, password, name }" },
      { method: "POST", path: "/api/auth/login", description: "Login with credentials", auth: false, requestBody: "{ email, password }" },
      { method: "POST", path: "/api/auth/logout", description: "Logout", auth: true },
      { method: "GET", path: "/api/auth/me", description: "Get current user", auth: true },
    );
  }

  // CRUD endpoints for each non-User entity
  for (const entity of schema) {
    if (entity.name === "User") continue;

    const plural = entity.name.toLowerCase() + "s";
    const needsAuth = entity.fields.some(f => f.reference === "User.id");

    endpoints.push(
      { method: "GET", path: `/api/${plural}`, description: `List all ${plural}`, auth: needsAuth },
      { method: "GET", path: `/api/${plural}/:id`, description: `Get ${entity.name} by ID`, auth: needsAuth },
      { method: "POST", path: `/api/${plural}`, description: `Create ${entity.name}`, auth: needsAuth },
      { method: "PUT", path: `/api/${plural}/:id`, description: `Update ${entity.name}`, auth: needsAuth },
      { method: "DELETE", path: `/api/${plural}/:id`, description: `Delete ${entity.name}`, auth: needsAuth },
    );
  }

  return endpoints;
}

// ─── UI Pages Builder ────────────────────────────────────────────────────────

function buildPages(discovery: DiscoveryResult, _answers: UserAnswer[]): UiPage[] {
  if (!discovery.detectedLayers.includes("frontend")) return [];

  const pages: UiPage[] = [];
  const hasAuth = discovery.detectedLayers.includes("auth");

  // Always have a home page
  pages.push({
    path: "/",
    name: "Home",
    description: "Landing page / main dashboard",
    components: ["Hero", "FeatureList"],
    layout: "public"
  });

  if (hasAuth) {
    pages.push(
      { path: "/login", name: "Login", description: "Login page", components: ["LoginForm"], layout: "public" },
      { path: "/register", name: "Register", description: "Registration page", components: ["RegisterForm"], layout: "public" },
      { path: "/dashboard", name: "Dashboard", description: "User dashboard", components: ["DashboardStats", "RecentActivity"], layout: "authenticated" },
      { path: "/settings", name: "Settings", description: "User settings", components: ["ProfileForm", "PasswordForm"], layout: "authenticated" },
    );
  }

  // Domain-specific pages
  const prompt = discovery.originalPrompt.toLowerCase();
  if (/todo|할일|task/i.test(prompt)) {
    pages.push({
      path: hasAuth ? "/dashboard" : "/",
      name: "TodoList",
      description: "Main todo list view",
      components: ["TodoForm", "TodoList", "TodoFilter"],
      layout: hasAuth ? "authenticated" : "public"
    });
  }

  if (/blog|블로그/i.test(prompt)) {
    pages.push(
      { path: "/posts", name: "PostList", description: "Blog post listing", components: ["PostCard", "Pagination"], layout: "public" },
      { path: "/posts/:slug", name: "PostDetail", description: "Single post view", components: ["PostContent", "CommentList", "CommentForm"], layout: "public" },
      { path: "/posts/new", name: "PostEditor", description: "Create/edit post", components: ["MarkdownEditor", "PostMetadata"], layout: "authenticated" },
    );
  }

  if (/shop|store|상점|쇼핑|commerce/i.test(prompt)) {
    pages.push(
      { path: "/products", name: "ProductList", description: "Product catalog", components: ["ProductCard", "CategoryFilter", "SearchBar", "Pagination"], layout: "public" },
      { path: "/products/:slug", name: "ProductDetail", description: "Product details", components: ["ProductGallery", "ProductInfo", "AddToCart"], layout: "public" },
      { path: "/cart", name: "Cart", description: "Shopping cart", components: ["CartItemList", "CartSummary"], layout: "public" },
      { path: "/checkout", name: "Checkout", description: "Checkout flow", components: ["CheckoutForm", "OrderSummary"], layout: "authenticated" },
    );
  }

  if (/chat|채팅/i.test(prompt)) {
    pages.push(
      { path: "/chat", name: "ChatRooms", description: "Chat room list", components: ["RoomList", "CreateRoomDialog"], layout: "authenticated" },
      { path: "/chat/:roomId", name: "ChatRoom", description: "Chat room view", components: ["MessageList", "MessageInput", "MemberList"], layout: "authenticated" },
    );
  }

  return pages;
}

// ─── UI Components Builder ───────────────────────────────────────────────────

function buildComponents(
  discovery: DiscoveryResult,
  _answers: UserAnswer[],
  pages: UiPage[]
): UiComponent[] {
  if (!discovery.detectedLayers.includes("frontend")) return [];

  const components: UiComponent[] = [];

  // Shared layout components
  components.push(
    { name: "Header", description: "App header with navigation", shared: true },
    { name: "Footer", description: "App footer", shared: true },
    { name: "Sidebar", description: "Sidebar navigation", shared: true },
    { name: "LoadingSpinner", description: "Loading indicator", shared: true },
    { name: "ErrorBoundary", description: "Error boundary wrapper", shared: true },
    { name: "EmptyState", description: "Empty state placeholder", shared: true },
    { name: "ConfirmDialog", description: "Confirmation dialog", shared: true },
    { name: "Toast", description: "Toast notification system", shared: true },
  );

  // Extract unique component names from pages
  const pageComponents = new Set<string>();
  for (const page of pages) {
    for (const comp of page.components) {
      pageComponents.add(comp);
    }
  }

  for (const name of pageComponents) {
    if (components.some(c => c.name === name)) continue;
    components.push({
      name,
      description: `${name} component for ${pages.find(p => p.components.includes(name))?.name ?? "app"}`,
      shared: false
    });
  }

  return components;
}

// ─── File List Builder ───────────────────────────────────────────────────────

function buildFileList(
  discovery: DiscoveryResult,
  _answers: UserAnswer[],
  schema: SchemaEntity[],
  endpoints: ApiEndpoint[],
  pages: UiPage[],
  components: UiComponent[]
): FileSpec[] {
  const files: FileSpec[] = [];
  const isNextJs = discovery.suggestedStack["frontend"]?.includes("Next.js");
  const hasBackend = discovery.detectedLayers.includes("backend");
  const hasFrontend = discovery.detectedLayers.includes("frontend");
  const hasDB = discovery.detectedLayers.includes("database");
  const hasAuth = discovery.detectedLayers.includes("auth");

  // ── Scaffold phase ─────────────────────────────────────────────────────

  files.push(
    { path: "package.json", description: "Project manifest", phase: "scaffold" },
    { path: "tsconfig.json", description: "TypeScript config", phase: "scaffold" },
    { path: ".eslintrc.json", description: "ESLint config", phase: "scaffold" },
    { path: ".prettierrc", description: "Prettier config", phase: "scaffold" },
    { path: ".gitignore", description: "Git ignore rules", phase: "scaffold" },
    { path: ".env.example", description: "Environment variable template", phase: "scaffold" },
    { path: ".env.local", description: "Local environment variables", phase: "scaffold" },
  );

  if (isNextJs) {
    files.push(
      { path: "next.config.ts", description: "Next.js config", phase: "scaffold" },
      { path: "tailwind.config.ts", description: "Tailwind CSS config", phase: "scaffold" },
      { path: "postcss.config.js", description: "PostCSS config", phase: "scaffold" },
    );
  }

  // ── Schema phase ───────────────────────────────────────────────────────

  if (hasDB) {
    files.push(
      { path: "src/db/schema.ts", description: "Database schema definitions", phase: "schema", dependsOn: ["package.json"] },
      { path: "src/db/index.ts", description: "Database client/connection", phase: "schema", dependsOn: ["src/db/schema.ts"] },
      { path: "src/db/seed.ts", description: "Database seed data", phase: "schema", dependsOn: ["src/db/schema.ts"] },
      { path: "drizzle.config.ts", description: "Drizzle ORM config", phase: "schema", dependsOn: ["package.json"] },
    );
  }

  // Types
  files.push(
    { path: "src/types/index.ts", description: "Shared TypeScript types", phase: "schema" },
  );

  for (const entity of schema) {
    files.push({
      path: `src/types/${entity.name.toLowerCase()}.ts`,
      description: `${entity.name} type definitions`,
      phase: "schema"
    });
  }

  // ── Backend phase ──────────────────────────────────────────────────────

  if (hasBackend || isNextJs) {
    // API routes
    if (isNextJs) {
      // Group endpoints by resource
      const resources = new Set(endpoints.map(e => e.path.split("/")[2]).filter(Boolean));
      for (const resource of resources) {
        if (resource === "auth") {
          files.push(
            { path: `src/app/api/auth/[...nextauth]/route.ts`, description: "NextAuth catch-all route", phase: "backend", dependsOn: ["src/db/schema.ts"] },
          );
        } else {
          files.push(
            { path: `src/app/api/${resource}/route.ts`, description: `${resource} list/create API`, phase: "backend", dependsOn: ["src/db/schema.ts"] },
            { path: `src/app/api/${resource}/[id]/route.ts`, description: `${resource} get/update/delete API`, phase: "backend", dependsOn: ["src/db/schema.ts"] },
          );
        }
      }
    } else {
      files.push(
        { path: "src/server/index.ts", description: "Server entry point", phase: "backend" },
        { path: "src/server/routes.ts", description: "API route definitions", phase: "backend" },
      );
      for (const entity of schema) {
        if (entity.name === "User" && hasAuth) continue;
        files.push({
          path: `src/server/routes/${entity.name.toLowerCase()}.ts`,
          description: `${entity.name} API routes`,
          phase: "backend",
          dependsOn: ["src/db/schema.ts"]
        });
      }
    }

    // Middleware
    if (hasAuth) {
      files.push(
        { path: "src/lib/auth.ts", description: "Auth configuration and helpers", phase: "backend" },
        { path: isNextJs ? "src/middleware.ts" : "src/server/middleware/auth.ts", description: "Auth middleware", phase: "backend" },
      );
    }

    // Utilities
    files.push(
      { path: "src/lib/utils.ts", description: "Shared utility functions", phase: "backend" },
      { path: "src/lib/validation.ts", description: "Input validation schemas (Zod)", phase: "backend" },
    );
  }

  // ── Frontend phase ─────────────────────────────────────────────────────

  if (hasFrontend) {
    if (isNextJs) {
      files.push(
        { path: "src/app/layout.tsx", description: "Root layout", phase: "frontend" },
        { path: "src/app/globals.css", description: "Global styles + Tailwind imports", phase: "frontend" },
        { path: "src/app/not-found.tsx", description: "404 page", phase: "frontend" },
        { path: "src/app/error.tsx", description: "Error boundary page", phase: "frontend" },
        { path: "src/app/loading.tsx", description: "Global loading state", phase: "frontend" },
      );

      // Pages
      for (const page of pages) {
        const routePath = page.path === "/" ? "" : page.path.replace(/:\w+/g, "[id]");
        files.push({
          path: `src/app${routePath}/page.tsx`,
          description: `${page.name} page`,
          phase: "frontend",
          dependsOn: page.layout === "authenticated" ? ["src/lib/auth.ts"] : undefined,
        });
      }
    }

    // Shared components
    for (const comp of components.filter(c => c.shared)) {
      files.push({
        path: `src/components/ui/${comp.name.toLowerCase()}.tsx`,
        description: comp.description,
        phase: "frontend"
      });
    }

    // Feature components
    for (const comp of components.filter(c => !c.shared)) {
      files.push({
        path: `src/components/${comp.name.toLowerCase()}.tsx`,
        description: comp.description,
        phase: "frontend"
      });
    }

    // Hooks
    files.push(
      { path: "src/hooks/use-toast.ts", description: "Toast notification hook", phase: "frontend" },
    );

    if (hasAuth) {
      files.push(
        { path: "src/hooks/use-auth.ts", description: "Auth state hook", phase: "frontend" },
      );
    }
  }

  // ── Testing phase ──────────────────────────────────────────────────────

  files.push(
    { path: "vitest.config.ts", description: "Vitest configuration", phase: "testing" },
  );

  // Unit tests for each entity
  for (const entity of schema) {
    if (hasBackend || isNextJs) {
      files.push({
        path: `tests/${entity.name.toLowerCase()}.test.ts`,
        description: `${entity.name} API tests`,
        phase: "testing",
        dependsOn: hasDB ? ["src/db/schema.ts"] : undefined
      });
    }
  }

  if (hasFrontend) {
    files.push(
      { path: "tests/pages.test.tsx", description: "Page render tests", phase: "testing" },
      { path: "tests/components.test.tsx", description: "Component unit tests", phase: "testing" },
    );
  }

  // ── Polish phase ───────────────────────────────────────────────────────

  files.push(
    { path: "README.md", description: "Project documentation", phase: "polish" },
  );

  return files;
}

// ─── Phase Builder ───────────────────────────────────────────────────────────

function buildPhases(
  discovery: DiscoveryResult,
  _answers: UserAnswer[],
  files: FileSpec[],
  schema: SchemaEntity[],
  endpoints: ApiEndpoint[],
  pages: UiPage[],
  components: UiComponent[]
): BlueprintPhaseSpec[] {
  const phases: BlueprintPhaseSpec[] = [];
  let taskCounter = 0;

  const makeTask = (
    title: string,
    category: RoleCategory,
    roleHint?: string,
    dependsOn?: string[]
  ): PlannerTask => ({
    id: `bp-${++taskCounter}`,
    title,
    category,
    roleHint,
    dependsOn,
  });

  // Phase 1: Scaffold
  const scaffoldFiles = files.filter(f => f.phase === "scaffold");
  phases.push({
    phase: "scaffold",
    order: 1,
    description: "Initialize project structure, configs, and dependencies",
    tasks: [
      makeTask("Create project directory and initialize package.json", "execution", "executor"),
      makeTask("Configure TypeScript, ESLint, Prettier", "execution", "executor"),
      makeTask("Install all dependencies", "execution", "executor"),
      makeTask("Set up project directory structure", "execution", "executor"),
    ],
    files: scaffoldFiles,
    roles: ["executor", "build-doctor"],
    evidence: ["package.json exists", "tsconfig.json valid", "npm install succeeds"],
    estimatedToolCalls: scaffoldFiles.length * 2 + 5,
  });

  // Phase 2: Schema
  if (schema.length > 0) {
    const schemaFiles = files.filter(f => f.phase === "schema");
    phases.push({
      phase: "schema",
      order: 2,
      description: "Define database schema, types, and seed data",
      tasks: [
        makeTask("Create shared TypeScript types for all entities", "execution", "executor"),
        ...(discovery.detectedLayers.includes("database")
          ? [
              makeTask("Define Drizzle ORM schema with all entities and relations", "execution", "db-engineer"),
              makeTask("Create database client and connection module", "execution", "db-engineer"),
              makeTask("Write seed data script", "execution", "db-engineer"),
              makeTask("Run initial migration", "execution", "db-engineer"),
            ]
          : []),
      ],
      files: schemaFiles,
      roles: ["executor", "db-engineer", "api-designer"],
      evidence: ["types compile", "schema valid", "migration runs"],
      estimatedToolCalls: schemaFiles.length * 2 + 3,
    });
  }

  // Phase 3: Backend
  if (discovery.detectedLayers.includes("backend") || discovery.suggestedStack["frontend"]?.includes("Next.js")) {
    const backendFiles = files.filter(f => f.phase === "backend");
    phases.push({
      phase: "backend",
      order: 3,
      description: "Implement API routes, middleware, and server logic",
      tasks: [
        ...(discovery.detectedLayers.includes("auth")
          ? [
              makeTask("Set up authentication system (NextAuth/Lucia)", "execution", "backend-engineer"),
              makeTask("Create auth middleware and route protection", "execution", "security-auditor"),
            ]
          : []),
        makeTask("Implement input validation schemas with Zod", "execution", "executor"),
        ...schema.filter(e => e.name !== "User").map(entity =>
          makeTask(`Implement ${entity.name} CRUD API routes`, "execution", "backend-engineer")
        ),
        makeTask("Add error handling middleware", "execution", "backend-engineer"),
        makeTask("Create utility functions", "execution", "executor"),
      ],
      files: backendFiles,
      roles: ["backend-engineer", "security-auditor", "api-designer", "executor"],
      evidence: ["API routes respond correctly", "auth flow works", "validation catches bad input"],
      estimatedToolCalls: backendFiles.length * 3 + endpoints.length,
    });
  }

  // Phase 4: Frontend
  if (discovery.detectedLayers.includes("frontend")) {
    const frontendFiles = files.filter(f => f.phase === "frontend");
    phases.push({
      phase: "frontend",
      order: 4,
      description: "Build UI pages, components, and layouts",
      tasks: [
        makeTask("Create root layout with header, footer, providers", "frontend", "frontend-engineer"),
        makeTask("Build shared UI components (Toast, Loading, Empty, Error)", "frontend", "frontend-engineer"),
        ...pages.map(page =>
          makeTask(`Build ${page.name} page (${page.path})`, "frontend", "frontend-engineer")
        ),
        ...components.filter(c => !c.shared).map(comp =>
          makeTask(`Build ${comp.name} component`, "frontend", "frontend-engineer")
        ),
        makeTask("Implement responsive layout and dark mode", "frontend", "frontend-engineer"),
        makeTask("Add loading states and error boundaries", "frontend", "frontend-engineer"),
      ],
      files: frontendFiles,
      roles: ["frontend-engineer", "ux-designer", "accessibility-auditor"],
      evidence: ["pages render", "no console errors", "responsive layout works"],
      estimatedToolCalls: frontendFiles.length * 3 + pages.length * 2,
    });
  }

  // Phase 5: Integration
  if (discovery.detectedLayers.includes("frontend") && discovery.detectedLayers.includes("backend")) {
    phases.push({
      phase: "integration",
      order: 5,
      description: "Wire frontend to backend, connect auth flows, test end-to-end",
      tasks: [
        makeTask("Connect frontend forms to API endpoints", "execution", "executor"),
        ...(discovery.detectedLayers.includes("auth")
          ? [makeTask("Wire auth flow: login → redirect → protected routes", "execution", "executor")]
          : []),
        makeTask("Add API error handling in frontend", "frontend", "frontend-engineer"),
        makeTask("Implement optimistic updates where appropriate", "frontend", "frontend-engineer"),
        makeTask("Test complete user flows manually", "execution", "executor"),
      ],
      files: [],
      roles: ["executor", "frontend-engineer", "test-engineer"],
      evidence: ["CRUD works end-to-end", "auth flow complete", "error states handled"],
      estimatedToolCalls: 20,
    });
  }

  // Phase 6: Testing
  const testFiles = files.filter(f => f.phase === "testing");
  phases.push({
    phase: "testing",
    order: 6,
    description: "Write and run tests to verify all functionality",
    tasks: [
      makeTask("Configure Vitest test runner", "execution", "test-engineer"),
      ...schema.map(entity =>
        makeTask(`Write tests for ${entity.name} API`, "execution", "test-engineer")
      ),
      ...(discovery.detectedLayers.includes("frontend")
        ? [
            makeTask("Write component render tests", "execution", "test-engineer"),
            makeTask("Write page integration tests", "execution", "test-engineer"),
          ]
        : []),
      makeTask("Run full test suite and fix failures", "execution", "test-engineer"),
    ],
    files: testFiles,
    roles: ["test-engineer", "executor"],
    evidence: ["all tests pass", "no type errors"],
    estimatedToolCalls: testFiles.length * 4 + 10,
  });

  // Phase 7: Polish
  const polishFiles = files.filter(f => f.phase === "polish");
  phases.push({
    phase: "polish",
    order: 7,
    description: "Final polish, documentation, and edge case handling",
    tasks: [
      makeTask("Write comprehensive README with setup instructions", "planning", "docs-writer"),
      makeTask("Add proper error messages and user feedback", "frontend", "ux-designer"),
      makeTask("Review security: input sanitization, CSRF, XSS protection", "review", "security-auditor"),
    ],
    files: polishFiles,
    roles: ["docs-writer", "ux-designer", "security-auditor", "reviewer"],
    evidence: ["README exists", "no security warnings"],
    estimatedToolCalls: polishFiles.length * 2 + 5,
  });

  // Phase 8: Verification
  phases.push({
    phase: "verification",
    order: 8,
    description: "Final build, lint, type-check, and test run",
    tasks: [
      makeTask("Run TypeScript type checker (tsc --noEmit)", "execution", "build-doctor"),
      makeTask("Run ESLint on all files", "execution", "build-doctor"),
      makeTask("Run full test suite", "execution", "test-engineer"),
      makeTask("Run production build", "execution", "build-doctor"),
      makeTask("Verify all evidence requirements are satisfied", "review", "reviewer"),
    ],
    files: [],
    roles: ["build-doctor", "test-engineer", "reviewer"],
    evidence: ["tsc passes", "eslint passes", "tests pass", "build succeeds"],
    estimatedToolCalls: 15,
  });

  return phases;
}

// ─── Directory Structure Builder ─────────────────────────────────────────────

function buildDirectoryStructure(files: FileSpec[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return Array.from(dirs).sort();
}

// ─── Dependencies Builder ────────────────────────────────────────────────────

function buildDependencies(discovery: DiscoveryResult): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};
  const layers = discovery.detectedLayers;
  const isNextJs = discovery.suggestedStack["frontend"]?.includes("Next.js");

  // Core
  if (isNextJs) {
    deps["next"] = "latest";
    deps["react"] = "latest";
    deps["react-dom"] = "latest";
  }

  // Styling
  if (layers.includes("frontend") || layers.includes("styling")) {
    deps["tailwindcss"] = "latest";
    deps["@tailwindcss/postcss"] = "latest";
    deps["class-variance-authority"] = "latest";
    deps["clsx"] = "latest";
    deps["tailwind-merge"] = "latest";
    deps["lucide-react"] = "latest";
  }

  // Database
  if (layers.includes("database")) {
    deps["drizzle-orm"] = "latest";
    deps["better-sqlite3"] = "latest";
    devDeps["drizzle-kit"] = "latest";
    devDeps["@types/better-sqlite3"] = "latest";
  }

  // Auth
  if (layers.includes("auth")) {
    deps["next-auth"] = "latest";
    deps["bcryptjs"] = "latest";
    devDeps["@types/bcryptjs"] = "latest";
  }

  // Validation
  deps["zod"] = "latest";

  // Backend (non-Next.js)
  if (layers.includes("backend") && !isNextJs) {
    deps["hono"] = "latest";
  }

  // Real-time
  if (layers.includes("real-time")) {
    deps["socket.io"] = "latest";
    deps["socket.io-client"] = "latest";
  }

  // Dev dependencies
  devDeps["typescript"] = "latest";
  devDeps["vitest"] = "latest";
  devDeps["eslint"] = "latest";
  devDeps["prettier"] = "latest";
  devDeps["@types/node"] = "latest";

  if (isNextJs) {
    devDeps["@types/react"] = "latest";
    devDeps["@types/react-dom"] = "latest";
    devDeps["@testing-library/react"] = "latest";
    devDeps["@testing-library/jest-dom"] = "latest";
  }

  return { dependencies: deps, devDependencies: devDeps };
}

// ─── Environment Variables Builder ───────────────────────────────────────────

function buildEnvVars(
  discovery: DiscoveryResult,
  _answers: UserAnswer[]
): Array<{ key: string; description: string; required: boolean; example: string }> {
  const vars: Array<{ key: string; description: string; required: boolean; example: string }> = [];

  if (discovery.detectedLayers.includes("database")) {
    vars.push({ key: "DATABASE_URL", description: "Database connection string", required: true, example: "file:./dev.db" });
  }

  if (discovery.detectedLayers.includes("auth")) {
    vars.push(
      { key: "NEXTAUTH_SECRET", description: "NextAuth secret key", required: true, example: "your-secret-key-here" },
      { key: "NEXTAUTH_URL", description: "App URL for auth callbacks", required: true, example: "http://localhost:3000" },
    );

    // OAuth providers
    vars.push(
      { key: "GOOGLE_CLIENT_ID", description: "Google OAuth client ID", required: false, example: "your-google-client-id" },
      { key: "GOOGLE_CLIENT_SECRET", description: "Google OAuth client secret", required: false, example: "your-google-client-secret" },
    );
  }

  if (discovery.detectedLayers.includes("api-integration")) {
    vars.push({ key: "API_KEY", description: "External API key", required: false, example: "your-api-key" });
  }

  vars.push({ key: "NODE_ENV", description: "Environment", required: false, example: "development" });

  return vars;
}

// ─── Format Blueprint for Display ────────────────────────────────────────────

export function formatBlueprintSummary(blueprint: AppBlueprint): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              📐 앱 설계도 (Blueprint)                         ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`📦 프로젝트: ${blueprint.name}`);
  lines.push(`📋 설명: ${blueprint.description}`);
  lines.push(`📊 복잡도: ${blueprint.discovery.complexity}`);
  lines.push(`📁 총 파일: ${blueprint.totalFiles}개 | 📝 총 태스크: ${blueprint.totalTasks}개`);
  lines.push("");

  lines.push("── 기술 스택 ──────────────────────────────────────────────");
  for (const [key, value] of Object.entries(blueprint.stack)) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push("");

  if (blueprint.schema.length > 0) {
    lines.push("── 데이터 모델 ────────────────────────────────────────────");
    for (const entity of blueprint.schema) {
      lines.push(`  📦 ${entity.name}: ${entity.fields.length} fields — ${entity.description}`);
    }
    lines.push("");
  }

  if (blueprint.endpoints.length > 0) {
    lines.push(`── API 엔드포인트 (${blueprint.endpoints.length}개) ──────────────────────────`);
    for (const ep of blueprint.endpoints.slice(0, 10)) {
      lines.push(`  ${ep.method.padEnd(6)} ${ep.path} ${ep.auth ? "🔒" : "🔓"} — ${ep.description}`);
    }
    if (blueprint.endpoints.length > 10) {
      lines.push(`  ... 외 ${blueprint.endpoints.length - 10}개`);
    }
    lines.push("");
  }

  if (blueprint.pages.length > 0) {
    lines.push(`── UI 페이지 (${blueprint.pages.length}개) ────────────────────────────────`);
    for (const page of blueprint.pages) {
      lines.push(`  ${page.path.padEnd(20)} ${page.name} — ${page.description}`);
    }
    lines.push("");
  }

  lines.push("── 실행 단계 ──────────────────────────────────────────────");
  for (const phase of blueprint.phases) {
    const taskCount = phase.tasks.length;
    const fileCount = phase.files.length;
    lines.push(`  ${phase.order}. ${phase.phase.toUpperCase().padEnd(15)} ${taskCount} tasks, ${fileCount} files — ${phase.description}`);
  }
  lines.push("");

  if (blueprint.envVars.length > 0) {
    lines.push("── 환경 변수 ──────────────────────────────────────────────");
    for (const v of blueprint.envVars) {
      lines.push(`  ${v.required ? "🔴" : "⚪"} ${v.key} — ${v.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
