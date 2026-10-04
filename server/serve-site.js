/**
 * Static file server for local development of the CRISP AND CLOUD site.
 *
 *   npm run serve        ->  http://localhost:8080
 *
 * Serves the project root (index.html, firebase-config.js, images, manifest)
 * but hard-refuses anything under server/ so the WhatsApp auth keys in
 * server/.wa-session/ are never downloadable over HTTP.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SITE_PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';

  // Resolve inside ROOT and confirm it did not escape via ../ or an absolute path.
  const target = path.resolve(ROOT, '.' + pathname);

  // Refuse anything inside server/ — it holds auth credentials and node_modules.
  const relToServer = path.relative(path.join(ROOT, 'server'), target);
  const insideServer = relToServer === '' ||
    (!relToServer.startsWith('..') && !path.isAbsolute(relToServer));

  const escapesRoot = target !== ROOT && !target.startsWith(ROOT + path.sep);

  if (insideServer || escapesRoot) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden — server/ is not served');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🍽️  CRISP AND CLOUD running at  http://localhost:${PORT}`);
  console.log(`      Admin panel  ->  click the logo 12x to unlock, then 📲 WhatsApp Alerts`);
  console.log(`      WhatsApp QR  ->  http://localhost:8080 (the bridge runs separately on :3000)`);
  console.log(`      Serving only project root; server/ is blocked.\n`);
});