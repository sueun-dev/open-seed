import { describe, expect, it } from "vitest";

import { extractJsonBlock } from "../src/core/utils.js";

describe("extractJsonBlock", () => {
  it("extracts a balanced JSON object with trailing prose", () => {
    const raw = 'prefix {"value":1,"nested":{"text":"brace } kept"}} trailing';
    expect(extractJsonBlock(raw)).toBe('{"value":1,"nested":{"text":"brace } kept"}}');
  });

  it("extracts a balanced JSON array when it appears first", () => {
    const raw = 'noise [1, {"ok": true}, 3] trailing';
    expect(extractJsonBlock(raw)).toBe('[1, {"ok": true}, 3]');
  });
});
