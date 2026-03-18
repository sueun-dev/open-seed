import { describe, it, expect, vi } from "vitest";
import { isAstGrepAvailable, astGrepSearch } from "../src/tools/ast-grep.js";

describe("ast-grep integration", () => {
  it("reports availability status", async () => {
    // This test checks the availability detection works without crashing
    const available = await isAstGrepAvailable();
    expect(typeof available).toBe("boolean");
  });

  it("returns structured result even when unavailable", async () => {
    const result = await astGrepSearch({
      cwd: process.cwd(),
      pattern: "$FN($ARGS)",
      language: "typescript"
    });

    expect(result).toHaveProperty("available");
    expect(result).toHaveProperty("pattern", "$FN($ARGS)");
    expect(result).toHaveProperty("language", "typescript");
    expect(result).toHaveProperty("matches");
    expect(Array.isArray(result.matches)).toBe(true);

    if (!result.available) {
      expect(result.error).toContain("ast-grep");
    }
  });

  it("handles invalid patterns gracefully", async () => {
    const result = await astGrepSearch({
      cwd: process.cwd(),
      pattern: ""
    });

    // Should not crash even with empty pattern
    expect(result).toHaveProperty("available");
    expect(result).toHaveProperty("matches");
  });
});
