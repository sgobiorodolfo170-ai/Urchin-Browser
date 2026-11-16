/** Local-only fixture for the native DevTools acceptance walkthrough. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const page = new URL(
  '../apps/desktop/tests/e2e/fixtures/native-devtools/page.html',
  import.meta.url,
);
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (req.url?.startsWith('/probe?')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('P0 network captured');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(page));
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
