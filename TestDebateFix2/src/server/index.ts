import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { handleApiRoute } from './routes.js';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createAppServer(root = process.cwd()) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

      if (url.pathname.startsWith('/api/')) {
        const route = await handleApiRoute(request, response, url.pathname);

        if (route.handled) {
          return;
        }
      }

      const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const safePath = normalize(requestPath).replace(/^(\.\.([/\\]|$))+/, '');
      const filePath = join(root, safePath);
      const content = await readFile(filePath);
      const extension = extname(filePath);

      response.writeHead(200, {
        'Content-Type': mimeTypes[extension] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}
