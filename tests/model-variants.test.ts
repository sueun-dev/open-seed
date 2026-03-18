import { describe, it, expect } from "vitest";
import {
  detectModelFamily,
  getModelVariant,
  getProviderVariant,
  applyVariantToPrompt,
  getCacheControlHeaders
} from "../src/orchestration/model-variants.js";

describe("Model Variants", () => {
  describe("detectModelFamily", () => {
    it("detects Claude models", () => {
      expect(detectModelFamily("claude-opus-4-6")).toBe("claude");
      expect(detectModelFamily("claude-sonnet-4-5")).toBe("claude");
      expect(detectModelFamily("claude-haiku-4-5")).toBe("claude");
      expect(detectModelFamily("anthropic/claude-3")).toBe("claude");
    });

    it("detects GPT models", () => {
      expect(detectModelFamily("gpt-5.4")).toBe("gpt");
      expect(detectModelFamily("gpt-4o")).toBe("gpt");
      expect(detectModelFamily("o3-mini")).toBe("gpt");
    });

    it("detects Gemini models", () => {
      expect(detectModelFamily("gemini-3-pro")).toBe("gemini");
      expect(detectModelFamily("google/palm-2")).toBe("gemini");
    });

    it("falls back to generic", () => {
      expect(detectModelFamily("llama-3.1")).toBe("generic");
      expect(detectModelFamily("mistral-large")).toBe("generic");
    });
  });

  describe("getModelVariant", () => {
    it("returns Claude variant config", () => {
      const variant = getModelVariant("claude-opus-4-6");
      expect(variant.family).toBe("claude");
      expect(variant.supportsCacheControl).toBe(true);
      expect(variant.useChainOfThought).toBe(true);
    });

    it("returns GPT variant config", () => {
      const variant = getModelVariant("gpt-5.4");
      expect(variant.family).toBe("gpt");
      expect(variant.toolInstructionStyle).toBe("function_call");
    });
  });

  describe("getProviderVariant", () => {
    it("maps provider IDs to variants", () => {
      expect(getProviderVariant("anthropic").family).toBe("claude");
      expect(getProviderVariant("openai").family).toBe("gpt");
      expect(getProviderVariant("gemini").family).toBe("gemini");
      expect(getProviderVariant("unknown").family).toBe("generic");
    });
  });

  describe("applyVariantToPrompt", () => {
    it("adds model-specific prefix", () => {
      const variant = getModelVariant("claude-opus-4-6");
      const result = applyVariantToPrompt("Do the task", variant);
      expect(result).toContain("expert software engineer");
      expect(result).toContain("Think step by step");
      expect(result).toContain("Do the task");
    });
  });

  describe("getCacheControlHeaders", () => {
    it("returns cache_control for Claude tool messages", () => {
      const variant = getModelVariant("claude-opus-4-6");
      const headers = getCacheControlHeaders(variant, "tool");
      expect(headers).toEqual({ cache_control: { type: "ephemeral" } });
    });

    it("returns undefined for non-Claude models", () => {
      const variant = getModelVariant("gpt-5.4");
      expect(getCacheControlHeaders(variant, "tool")).toBeUndefined();
    });

    it("returns undefined for non-tool roles on Claude", () => {
      const variant = getModelVariant("claude-opus-4-6");
      expect(getCacheControlHeaders(variant, "user")).toBeUndefined();
    });
  });
});
