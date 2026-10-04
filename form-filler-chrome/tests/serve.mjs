// 手测用的静态服务：把 tests/ 目录挂到 http 上。
//
// 为什么要它：content script 不能在 file:// 上跑（除非专门开"允许访问文件网址"），
// 而自动测试各自起的是临时端口、跑完就关，没法一边点一边看。
//
// 运行: node tests/serve.mjs [端口]   默认 8080
//   然后打开 http://127.0.0.1:8080/fixture.html

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'fixture.html';
  // 只允许读 tests/ 底下的东西：这个服务只给本机看，但没必要给它穿越目录的能力。
  const p = path.resolve(__dirname, rel);
  if (!p.startsWith(__dirname)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const body = fs.readFileSync(p);
    res.setHeader('Content-Type', TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.html'));
  console.log(`\n  http://127.0.0.1:${PORT}/fixture.html\n`);
  console.log(`  可以打开的页面：\n${files.map((f) => `    http://127.0.0.1:${PORT}/${f}`).join('\n')}\n`);
  console.log('  Ctrl+C 结束。\n');
});
