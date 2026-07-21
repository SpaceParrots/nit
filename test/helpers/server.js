// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny static server for the fixture SPA. Sends a CSP header like a hardened
// production site would (nit must work regardless, via bypassCSP).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = path.join(FIXTURES, urlPath.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(FIXTURES, 'page.html'); // SPA fallback: every route serves the app
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
