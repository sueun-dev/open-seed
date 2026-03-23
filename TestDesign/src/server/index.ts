import { createServer } from 'node:http';
import { handleRequest } from './routes.js';

const rawPort = process.env['PORT'] ?? '3000';
const parsed = parseInt(rawPort, 10);
const PORT = Number.isNaN(parsed) || parsed < 0 || parsed > 65535 ? 3000 : parsed;

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Neon Snake server running on http://localhost:${PORT}`);
});

export { server, PORT };
