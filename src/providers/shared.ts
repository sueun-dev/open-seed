import type { ProviderConfig, ProviderRequest } from "../core/types.js";
import { extractJsonBlock } from "../core/utils.js";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
  }
}

export interface ProviderInvocationMetadata {
  attempts: number;
  streamed?: boolean;
}

/** Build an optional abort timeout. Returns null if timeoutMs is 0 or unset (no limit). */
function createAbortTimeout(controller: AbortController, timeoutMs: number | undefined): ReturnType<typeof setTimeout> | null {
  const ms = timeoutMs ?? 0;
  if (ms <= 0) return null;
  return setTimeout(() => controller.abort(), ms);
}

export async function requestJsonWithRetry<T>(params: {
  config: ProviderConfig;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{ json: T; metadata: ProviderInvocationMetadata }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const attempts = Math.max(1, (params.config.maxRetries ?? 2) + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = createAbortTimeout(controller, params.config.timeoutMs);

    try {
      const response = await fetchImpl(params.url, {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
        ...(timeout ? { signal: controller.signal } : {})
      });
      if (timeout) clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        if (attempt < attempts && shouldRetryStatus(response.status)) {
          await sleep(getRetryDelayMs(response.headers.get("retry-after"), attempt));
          continue;
        }
        throw new ProviderHttpError(`Provider request failed: ${response.status}`, response.status, body);
      }

      return {
        json: await response.json() as T,
        metadata: { attempts: attempt }
      };
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }
      await sleep(getRetryDelayMs(undefined, attempt));
    }
  }

  throw new Error("Unreachable provider retry state");
}

export function normalizeProviderText(text: string, request: ProviderRequest): string {
  if (request.responseFormat !== "json") {
    return text;
  }
  const normalized = extractJsonBlock(text);
  try {
    JSON.parse(normalized);
    return normalized;
  } catch {
    // If JSON parsing fails, try to salvage by wrapping in a minimal valid JSON
    // This prevents engine crashes when LLM returns truncated or non-JSON responses
    try {
      const wrapped = JSON.stringify({ summary: text.slice(0, 2000), changes: [], suggestedCommands: [], toolCalls: [] });
      return wrapped;
    } catch {
      return JSON.stringify({ summary: "LLM response was not valid JSON", changes: [], suggestedCommands: [], toolCalls: [] });
    }
  }
}

export interface SseMessage {
  event?: string;
  data: string;
}

export async function requestSseWithRetry<T = unknown>(params: {
  config: ProviderConfig;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl?: typeof fetch;
  onMessage: (message: SseMessage) => void | Promise<void>;
}): Promise<{ metadata: ProviderInvocationMetadata }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const attempts = Math.max(1, (params.config.maxRetries ?? 2) + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = createAbortTimeout(controller, params.config.timeoutMs);

    try {
      const response = await fetchImpl(params.url, {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
        ...(timeout ? { signal: controller.signal } : {})
      });
      if (timeout) clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        if (attempt < attempts && shouldRetryStatus(response.status)) {
          await sleep(getRetryDelayMs(response.headers.get("retry-after"), attempt));
          continue;
        }
        throw new ProviderHttpError(`Provider request failed: ${response.status}`, response.status, body);
      }

      if (!response.body) {
        throw new Error("Provider stream response is missing a body");
      }

      await consumeSse(response.body, params.onMessage);
      return {
        metadata: { attempts: attempt, streamed: true }
      };
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }
      await sleep(getRetryDelayMs(undefined, attempt));
    }
  }

  throw new Error("Unreachable provider retry state");
}

export async function emitTextInChunks(
  text: string,
  onTextDelta: ((chunk: string, providerId: "mock") => void | Promise<void>) | undefined,
  chunkSize = 48
): Promise<void> {
  if (!onTextDelta) {
    return;
  }
  for (let index = 0; index < text.length; index += chunkSize) {
    await onTextDelta(text.slice(index, index + chunkSize), "mock");
  }
}

function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    return shouldRetryStatus(error.status);
  }
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

function getRetryDelayMs(retryAfterHeader: string | null | undefined, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, date - Date.now());
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void | Promise<void>
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = findSseSeparator(buffer);
    while (separatorIndex >= 0) {
      const rawMessage = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + sseSeparatorLength(buffer, separatorIndex));
      const message = parseSseMessage(rawMessage);
      if (message) {
        await onMessage(message);
      }
      separatorIndex = findSseSeparator(buffer);
    }

    if (done) {
      break;
    }
  }

  const trailing = buffer.trim();
  if (trailing.length > 0) {
    const message = parseSseMessage(trailing);
    if (message) {
      await onMessage(message);
    }
  }
}

function parseSseMessage(rawMessage: string): SseMessage | null {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith(":"));

  if (lines.length === 0) {
    return null;
  }

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

function findSseSeparator(buffer: string): number {
  const unix = buffer.indexOf("\n\n");
  const windows = buffer.indexOf("\r\n\r\n");
  if (unix === -1) {
    return windows;
  }
  if (windows === -1) {
    return unix;
  }
  return Math.min(unix, windows);
}

function sseSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}
