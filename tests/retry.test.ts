import { describe, it, expect } from "vitest";
import {
  withRetry,
  truncateObservation,
  parseJsonWithRecovery,
  createRetryPolicy
} from "../src/orchestration/retry.js";

describe("Retry Framework", () => {
  describe("withRetry", () => {
    it("succeeds on first attempt", async () => {
      const result = await withRetry(async () => "success");
      expect(result.value).toBe("success");
      expect(result.attempts).toBe(1);
      expect(result.lastError).toBeNull();
    });

    it("retries retryable errors", async () => {
      let attempt = 0;
      const result = await withRetry(async () => {
        attempt++;
        if (attempt < 3) throw new Error("timeout error");
        return "recovered";
      }, createRetryPolicy({ maxRetries: 3 }));

      expect(result.value).toBe("recovered");
      expect(result.attempts).toBe(3);
    });

    it("stops on fatal errors", async () => {
      const result = await withRetry(async () => {
        throw new Error("Unknown tool: bad_tool");
      });

      expect(result.value).toBeNull();
      expect(result.attempts).toBe(1);
      expect(result.lastError).toContain("Unknown tool");
    });

    it("respects max retries", async () => {
      const result = await withRetry(
        async () => { throw new Error("timeout"); },
        createRetryPolicy({ maxRetries: 2 })
      );

      expect(result.value).toBeNull();
      expect(result.attempts).toBe(3);
    });
  });

  describe("truncateObservation", () => {
    it("does not truncate short text", () => {
      const { text, truncated } = truncateObservation("short text");
      expect(text).toBe("short text");
      expect(truncated).toBe(false);
    });

    it("truncates long text with head-tail strategy", () => {
      const long = "x".repeat(20_000);
      const policy = createRetryPolicy({ maxObservationLength: 10_000, truncationStrategy: "head-tail" });
      const { text, truncated } = truncateObservation(long, policy);
      expect(truncated).toBe(true);
      expect(text.length).toBeLessThan(long.length);
      expect(text).toContain("truncated");
    });

    it("truncates with tail-only strategy", () => {
      const long = "A".repeat(5000) + "B".repeat(15_000);
      const policy = createRetryPolicy({ maxObservationLength: 10_000, truncationStrategy: "tail-only" });
      const { text } = truncateObservation(long, policy);
      expect(text).toContain("B");
      expect(text).toContain("truncated");
    });
  });

  describe("parseJsonWithRecovery", () => {
    it("parses clean JSON", () => {
      const { parsed, recovered } = parseJsonWithRecovery('{"key": "value"}');
      expect(parsed).toEqual({ key: "value" });
      expect(recovered).toBe(false);
    });

    it("recovers from markdown fences", () => {
      const { parsed, recovered } = parseJsonWithRecovery('```json\n{"key": "value"}\n```');
      expect(parsed).toEqual({ key: "value" });
      expect(recovered).toBe(true);
    });

    it("recovers from surrounding text", () => {
      const { parsed, recovered } = parseJsonWithRecovery('Here is the result: {"key": "value"} end.');
      expect(parsed).toEqual({ key: "value" });
      expect(recovered).toBe(true);
    });

    it("throws on unparseable input", () => {
      expect(() => parseJsonWithRecovery("not json at all")).toThrow();
    });
  });
});
