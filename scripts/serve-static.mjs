// Minimal static file server for the Playwright e2e harness (webServer).
// Pure Node, zero dependencies, identical on Windows and CI — so e2e.yml needs
// no Python setup step. Serves the repo root so http://localhost:PORT/index.html
// loads the app exactly as it deploys. NOT for production — dev/test only.
//
// Usage: node scripts/serve-static.mjs [port]   (default 8123)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2]) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    // Path-traversal guard: the resolved file must stay under ROOT.
    if (filePath !== ROOT.replace(/[\\/]+$/, '') && !filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`static server on http://localhost:${PORT} (root: ${ROOT}${sep ? '' : ''})`));
