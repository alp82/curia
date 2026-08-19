// PROTOTYPE — wayfinder alp82/curia#537. Throwaway demo server.
// Serves the static mockup and proxies /terminal/ (HTTP + WebSocket) to a
// loopback ttyd, the same shape the dashboard sidecar takes in #536.
// No identity check here: the preview link is the access gate in this demo.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 9012);
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TTYD = { host: '127.0.0.1', port: 7681 };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const [path] = req.url.split('?');
  if (path === '/terminal') {
    res.writeHead(302, { location: '/terminal/' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '') });
    return res.end();
  }
  if (path.startsWith('/terminal/')) return proxyHttp(req, res);
  let f = path === '/' ? '/index.html' : decodeURIComponent(path);
  const fp = normalize(join(ROOT, f));
  if (!fp.startsWith(ROOT + sep) && fp !== join(ROOT, 'index.html')) { res.writeHead(403); return res.end(); }
  if (!existsSync(fp) || !statSync(fp).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
  createReadStream(fp).pipe(res);
});

function proxyHttp(req, res) {
  const up = http.request({ ...TTYD, path: req.url, method: req.method, headers: req.headers });
  up.on('response', ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('the terminal backend is down; the rest of the page stays up');
  });
  req.pipe(up);
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/terminal/')) return socket.destroy();
  const up = http.request({ ...TTYD, path: req.url, method: 'GET', headers: req.headers });
  up.on('upgrade', (ur, usock, uhead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(ur.rawHeaders[i] + ': ' + ur.rawHeaders[i + 1]);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (uhead && uhead.length) socket.write(uhead);
    if (head && head.length) usock.write(head);
    usock.pipe(socket); socket.pipe(usock);
    const kill = () => { socket.destroy(); usock.destroy(); };
    usock.on('error', kill); socket.on('error', kill);
    usock.on('close', kill); socket.on('close', kill);
  });
  up.on('response', ur => socket.end('HTTP/1.1 ' + ur.statusCode + ' ' + (ur.statusMessage || '') + '\r\n\r\n'));
  up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  up.end();
});

server.listen(PORT, '0.0.0.0', () => console.log('demo server on 0.0.0.0:' + PORT + ', /terminal/ -> ttyd :' + TTYD.port));
