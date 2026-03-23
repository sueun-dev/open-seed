import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRun, getGameSnapshot, listRuns } from './service.js';

interface RouteResult {
  readonly handled: boolean;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function handleApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<RouteResult> {
  if (pathname === '/api/health' && request.method === 'GET') {
    writeJson(response, 200, { status: 'ok' });
    return { handled: true };
  }

  if (pathname === '/api/game' && request.method === 'GET') {
    writeJson(response, 200, getGameSnapshot());
    return { handled: true };
  }

  if (pathname === '/api/runs' && request.method === 'GET') {
    writeJson(response, 200, { runs: listRuns() });
    return { handled: true };
  }

  if (pathname === '/api/runs' && request.method === 'POST') {
    try {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const run = createRun({
        startedAt: String(body.startedAt ?? ''),
        endedAt: String(body.endedAt ?? ''),
        survivalTimeMs: Number(body.survivalTimeMs ?? -1),
        hazardCount: Number(body.hazardCount ?? -1),
        difficultyPeak: Number(body.difficultyPeak ?? 0),
      });

      writeJson(response, 201, { run });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body.';
      writeJson(response, 400, { error: message });
    }

    return { handled: true };
  }

  return { handled: false };
}
