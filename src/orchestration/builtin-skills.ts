/**
 * Built-in Skills — OMO's 6 built-in skills.
 *
 * Skills are specialized capability packs that:
 * 1. Provide system prompt additions for specific tasks
 * 2. Can carry their own MCP servers
 * 3. Are auto-loaded when relevant keywords are detected
 */

export interface BuiltinSkill {
  name: string;
  description: string;
  /** Keywords that trigger this skill */
  triggerKeywords: string[];
  /** System prompt additions when skill is active */
  systemPromptAddition: string;
  /** MCP servers this skill brings */
  mcpServers?: string[];
  /** Tools this skill requires */
  requiredTools?: string[];
  enabledByDefault: boolean;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "playwright",
    description: "Browser automation with Playwright — test UIs, take screenshots, fill forms",
    triggerKeywords: ["browser", "screenshot", "playwright", "e2e", "visual", "ui test", "click", "navigate"],
    systemPromptAddition: [
      "## Playwright Skill Active",
      "You have browser automation capabilities via Playwright.",
      "- Use the browser tool to navigate, click, type, and screenshot",
      "- Always take a screenshot after significant UI actions for verification",
      "- Wait for network idle before asserting page state",
      "- Use CSS selectors preferring data-testid attributes",
      "- For form filling: click field → type value → verify",
      "- For navigation: goto URL → wait for selector → verify title",
    ].join("\n"),
    requiredTools: ["browser"],
    enabledByDefault: true
  },
  {
    name: "agent-browser",
    description: "Agent-controlled browser for research and data extraction",
    triggerKeywords: ["scrape", "extract", "crawl", "webpage", "fetch url", "download page"],
    systemPromptAddition: [
      "## Agent Browser Skill Active",
      "You can control a browser for research and data extraction.",
      "- Navigate to URLs and extract structured data",
      "- Handle pagination and infinite scroll",
      "- Extract tables, lists, and text content",
      "- Save screenshots as evidence",
    ].join("\n"),
    requiredTools: ["browser", "web_search"],
    enabledByDefault: true
  },
  {
    name: "dev-browser",
    description: "Development browser for debugging — inspect console, network, DOM",
    triggerKeywords: ["console error", "network request", "dom", "devtools", "debug ui", "inspect"],
    systemPromptAddition: [
      "## Dev Browser Skill Active",
      "You can inspect running web applications for debugging.",
      "- Check browser console for errors and warnings",
      "- Monitor network requests for failed API calls",
      "- Inspect DOM structure for layout issues",
      "- Check for accessibility violations",
      "- Verify responsive behavior at different viewports",
    ].join("\n"),
    requiredTools: ["browser"],
    enabledByDefault: true
  },
  {
    name: "frontend-ui-ux",
    description: "UI/UX best practices, accessibility, responsive design guidance",
    triggerKeywords: ["ui", "ux", "design", "accessibility", "a11y", "responsive", "layout", "css", "component", "figma"],
    systemPromptAddition: [
      "## Frontend UI/UX Skill Active",
      "Apply these UI/UX best practices:",
      "- Semantic HTML: use correct elements (nav, main, article, etc.)",
      "- Accessibility: ARIA labels, keyboard navigation, contrast ratios",
      "- Responsive: mobile-first, use relative units, test breakpoints",
      "- Performance: lazy load images, minimize layout shifts",
      "- Consistency: use design tokens/variables for colors, spacing, fonts",
      "- Feedback: loading states, error states, empty states, success confirmations",
      "- Touch targets: minimum 44x44px for mobile interactions",
      "- Dark mode: use CSS custom properties, respect prefers-color-scheme",
    ].join("\n"),
    enabledByDefault: true
  },
  {
    name: "git-master",
    description: "Advanced git operations — atomic commits, branch strategy, conflict resolution",
    triggerKeywords: ["git", "commit", "branch", "merge", "rebase", "conflict", "pr", "pull request", "cherry-pick"],
    systemPromptAddition: [
      "## Git Master Skill Active",
      "Apply these git best practices:",
      "- Atomic commits: each commit is one logical change",
      "- Conventional commits: type(scope): description",
      "- Branch naming: feature/xxx, fix/xxx, chore/xxx",
      "- Before commit: run tests, check for uncommitted files",
      "- Conflict resolution: understand both sides before choosing",
      "- Interactive rebase: squash fixup commits before merge",
      "- Never force push to shared branches without confirmation",
      "- Use git diff --staged to review before committing",
    ].join("\n"),
    requiredTools: ["git", "bash"],
    enabledByDefault: true
  },
  {
    name: "testing",
    description: "Test writing patterns — unit, integration, E2E, TDD workflow",
    triggerKeywords: ["test", "spec", "coverage", "jest", "vitest", "pytest", "tdd", "assertion", "mock"],
    systemPromptAddition: [
      "## Testing Skill Active",
      "Apply these testing best practices:",
      "- Test behavior, not implementation details",
      "- AAA pattern: Arrange, Act, Assert",
      "- One assertion per test when possible",
      "- Test edge cases: null, undefined, empty, boundary values",
      "- Mock external dependencies, not internal logic",
      "- Name tests descriptively: 'should [behavior] when [condition]'",
      "- Run existing tests FIRST to establish baseline",
      "- Write failing test before fixing (TDD red-green-refactor)",
      "- Integration tests for API endpoints with realistic data",
      "- E2E tests for critical user flows only",
    ].join("\n"),
    enabledByDefault: true
  }
];

export function getActiveSkills(task: string, disabledSkills: string[] = []): BuiltinSkill[] {
  const lower = task.toLowerCase();
  return BUILTIN_SKILLS.filter(skill =>
    skill.enabledByDefault &&
    !disabledSkills.includes(skill.name) &&
    skill.triggerKeywords.some(kw => lower.includes(kw))
  );
}

export function getAllSkills(): BuiltinSkill[] {
  return BUILTIN_SKILLS;
}

export function getSkillByName(name: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS.find(s => s.name === name);
}

export function buildSkillContext(skills: BuiltinSkill[]): string {
  if (skills.length === 0) return "";
  return skills.map(s => s.systemPromptAddition).join("\n\n");
}
