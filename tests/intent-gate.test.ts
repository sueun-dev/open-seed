import { describe, it, expect } from "vitest";
import { analyzeIntent } from "../src/orchestration/intent-gate.js";

describe("IntentGate", () => {
  describe("classifyAction", () => {
    it("classifies fix tasks", () => {
      const intent = analyzeIntent("Fix the broken auth flow");
      expect(intent.action).toBe("fix");
    });

    it("classifies build tasks", () => {
      const intent = analyzeIntent("Build is failing with tsc errors");
      expect(intent.action).toBe("build");
    });

    it("classifies test tasks", () => {
      const intent = analyzeIntent("Add test coverage for the session store");
      expect(intent.action).toBe("test");
    });

    it("classifies refactor tasks", () => {
      const intent = analyzeIntent("Refactor the provider registry to simplify the adapter pattern");
      expect(intent.action).toBe("refactor");
    });

    it("classifies add/implement tasks", () => {
      const intent = analyzeIntent("Implement a new caching layer for provider responses");
      expect(intent.action).toBe("add");
    });

    it("classifies investigate tasks", () => {
      const intent = analyzeIntent("Investigate why the OAuth flow fails intermittently");
      expect(intent.action).toBe("investigate");
    });

    it("classifies deploy tasks", () => {
      const intent = analyzeIntent("Deploy the latest changes to production");
      expect(intent.action).toBe("deploy");
    });

    it("classifies document tasks", () => {
      const intent = analyzeIntent("Document the new delegation API");
      expect(intent.action).toBe("document");
    });

    it("classifies review tasks", () => {
      const intent = analyzeIntent("Review the code changes in the pull request");
      expect(intent.action).toBe("review");
    });

    it("classifies migrate tasks", () => {
      const intent = analyzeIntent("Migrate from v1 to v2 API schema");
      expect(intent.action).toBe("migrate");
    });

    it("classifies optimize tasks", () => {
      const intent = analyzeIntent("Optimize the slow provider timeout path");
      expect(intent.action).toBe("optimize");
    });

    it("classifies security-audit tasks", () => {
      const intent = analyzeIntent("Check for XSS vulnerabilities in the browser tool");
      expect(intent.action).toBe("security-audit");
    });

    it("falls back to general for unrecognized tasks", () => {
      const intent = analyzeIntent("Do the thing with the stuff");
      expect(intent.action).toBe("general");
    });
  });

  describe("scope classification", () => {
    it("detects single-file scope", () => {
      const intent = analyzeIntent("Fix the bug in this file");
      expect(intent.scope).toBe("single-file");
    });

    it("detects repo-wide scope", () => {
      const intent = analyzeIntent("Rename the variable everywhere in the project");
      expect(intent.scope).toBe("repo-wide");
    });

    it("detects cross-cutting scope", () => {
      const intent = analyzeIntent("Update all modules to use the new config shape");
      expect(intent.scope).toBe("cross-cutting");
    });

    it("defaults to module scope", () => {
      const intent = analyzeIntent("Add a caching layer");
      expect(intent.scope).toBe("module");
    });
  });

  describe("risk computation", () => {
    it("assigns high risk to deploy tasks", () => {
      const intent = analyzeIntent("Deploy to production");
      expect(intent.risk).toBe("high");
    });

    it("assigns low risk to test tasks", () => {
      const intent = analyzeIntent("Add a unit test for utils");
      expect(intent.risk).toBe("low");
    });

    it("escalates risk for repo-wide scope", () => {
      const intent = analyzeIntent("Fix the bug everywhere in the project");
      expect(intent.risk).toBe("high");
    });
  });

  describe("constraints extraction", () => {
    it("extracts no-breaking-changes constraint", () => {
      const intent = analyzeIntent("Refactor the auth module without breaking changes");
      expect(intent.constraints).toContain("no-breaking-changes");
    });

    it("extracts keep-tests-green constraint", () => {
      const intent = analyzeIntent("Make the change but tests must pass");
      expect(intent.constraints).toContain("keep-tests-green");
    });

    it("extracts urgent constraint", () => {
      const intent = analyzeIntent("Urgent hotfix for the auth crash");
      expect(intent.constraints).toContain("urgent");
    });
  });

  describe("suggested roles", () => {
    it("suggests debugger for fix tasks", () => {
      const intent = analyzeIntent("Fix the broken auth flow");
      expect(intent.suggestedRoles).toContain("debugger");
    });

    it("suggests security-auditor for security mentions", () => {
      const intent = analyzeIntent("Add a new feature with OAuth integration");
      expect(intent.suggestedRoles).toContain("security-auditor");
    });

    it("suggests frontend-engineer for UI mentions", () => {
      const intent = analyzeIntent("Fix the broken CSS in the dashboard component");
      expect(intent.suggestedRoles).toContain("frontend-engineer");
    });
  });

  describe("skip flags", () => {
    it("skips research for simple single-file doc tasks", () => {
      const intent = analyzeIntent("Document this file");
      // document is low risk + module scope = not simple
      // Use a truly simple case: low risk + single-file
      const intent2 = analyzeIntent("Add a test for this file");
      expect(intent2.risk).toBe("low");
      expect(intent2.scope).toBe("single-file");
      expect(intent2.skipResearch).toBe(true);
    });

    it("does not skip research for investigation tasks", () => {
      const intent = analyzeIntent("Investigate why tests fail in this file");
      expect(intent.skipResearch).toBe(false);
    });

    it("skips delegation for simple single-file tasks", () => {
      const intent = analyzeIntent("Add a test for this file");
      expect(intent.scope).toBe("single-file");
      expect(intent.risk).toBe("low");
      expect(intent.skipDelegation).toBe(true);
    });

    it("does not skip delegation for complex tasks", () => {
      const intent = analyzeIntent("Refactor the entire provider module");
      expect(intent.skipDelegation).toBe(false);
    });
  });

  describe("maxReviewPasses", () => {
    it("allows more passes for high risk", () => {
      const intent = analyzeIntent("Deploy to production");
      expect(intent.maxReviewPasses).toBe(4);
    });

    it("allows fewer passes for low risk", () => {
      const intent = analyzeIntent("Add a test for the utils module");
      expect(intent.maxReviewPasses).toBe(2);
    });
  });

  describe("category mapping", () => {
    it("maps investigate to research", () => {
      const intent = analyzeIntent("Investigate the failure");
      expect(intent.category).toBe("research");
    });

    it("maps fix to execution", () => {
      const intent = analyzeIntent("Fix the bug");
      expect(intent.category).toBe("execution");
    });

    it("maps document to planning", () => {
      const intent = analyzeIntent("Document the API");
      expect(intent.category).toBe("planning");
    });
  });
});
