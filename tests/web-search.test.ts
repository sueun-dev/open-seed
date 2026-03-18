import { describe, it, expect } from "vitest";
import { webSearch } from "../src/tools/web-search.js";

describe("web-search integration", () => {
  it("returns structured result with query", async () => {
    const result = await webSearch({ query: "TypeScript vitest setup", maxResults: 3 });

    expect(result).toHaveProperty("query", "TypeScript vitest setup");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("source");
    expect(Array.isArray(result.results)).toBe(true);

    // source should be one of the known backends
    expect(["ddgr", "curl-ddg", "unavailable"]).toContain(result.source);
  });

  it("respects maxResults parameter", async () => {
    const result = await webSearch({ query: "node.js", maxResults: 2 });
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("each result has title, url, snippet structure", async () => {
    const result = await webSearch({ query: "vitest testing", maxResults: 3 });
    for (const entry of result.results) {
      expect(entry).toHaveProperty("title");
      expect(entry).toHaveProperty("url");
      expect(entry).toHaveProperty("snippet");
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.url).toBe("string");
      expect(typeof entry.snippet).toBe("string");
    }
  });
});
