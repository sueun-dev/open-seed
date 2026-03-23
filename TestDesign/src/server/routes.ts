import { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitScore, fetchTopScores, resetScores, ValidationError } from './service.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
};

function setSecurityHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function json(res: ServerResponse, statusCode: number, data: unknown): void {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 8 * 1024; // 8KB
const BODY_TIMEOUT_MS = 5000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const timer = setTimeout(() => {
      req.destroy();
      reject(new ValidationError('Request timeout', 408));
    }, BODY_TIMEOUT_MS);

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy();
        reject(new ValidationError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handleScoresApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (method === 'GET') {
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 10)) : 10;
    const result = fetchTopScores(limit);
    json(res, 200, result);
    return;
  }

  if (method === 'POST') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const result = submitScore(body);
    json(res, 201, result);
    return;
  }

  if (method === 'DELETE') {
    resetScores();
    json(res, 200, { cleared: true });
    return;
  }

  json(res, 405, { error: 'Method not allowed' });
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);

  // Default to index.html
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Security: reject null bytes and path traversal
  if (pathname.includes('\0') || pathname.includes('..')) {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const safePath = normalize(pathname).replace(/^(\.[\/\\])+/, '');
  const filePath = resolve(ROOT, safePath.startsWith('/') ? safePath.slice(1) : safePath);

  // Ensure resolved path is within ROOT
  if (!filePath.startsWith(ROOT)) {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Only serve specific safe extensions
  const ext = extname(filePath).toLowerCase();
  const allowedExtensions = new Set(['.html', '.css', '.js', '.png', '.svg', '.ico', '.json']);
  
  // Don't serve package.json, tsconfig.json, etc.
  const basename = filePath.split('/').pop() ?? '';
  if (basename === 'package.json' || basename === 'tsconfig.json' || basename === 'package-lock.json') {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (!allowedExtensions.has(ext)) {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const mime = MIME[ext] ?? 'application/octet-stream';

  try {
    const data = await readFile(filePath);
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    setSecurityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = req.url ?? '/';
    if (url.startsWith('/api/scores')) {
      await handleScoresApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      json(res, err.status, { error: err.message });
    } else {
      console.error('Internal error:', err);
      json(res, 500, { error: 'Internal server error' });
    }
  }
}
