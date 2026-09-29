// Dev server: GET /sum?n=1,2,3 and GET /avg?n=1,2,3.
const http = require('http');
const { sum } = require('./src/sum');
const { avg } = require('./src/avg');

const port = Number(process.env.PORT) || 5173;

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const numbers = (url.searchParams.get('n') || '').split(',').filter(Boolean).map(Number);
  const fn = { '/sum': sum, '/avg': avg }[url.pathname];
  res.setHeader('Content-Type', 'application/json');
  if (!fn) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  res.end(JSON.stringify({ result: fn(numbers) }));
}).listen(port, () => {
  console.log(`  Local: http://localhost:${port}/`);
});
