// Bounded, faithful fixture for Southbag Identity's internal freeze endpoint:
//   GET /api/internal/freeze?userId=...   Authorization: Bearer <FIXTURE_SECRET>
// Answers exactly what the real worker answers ({frozen, reason, frozenAt, unfrozenViaFlow}).
// Usage: node identity-fixture.mjs <port> <active|frozen|reject>
//   active -> 200 {"frozen":false,...}   frozen -> 200 {"frozen":true,...}
//   reject -> 403 (Identity up but REFUSING our secret, e.g. after rotation)
// A wrong bearer always gets 401, like the real endpoint. "Identity down" is simulated by
// simply not running the fixture.
import { createServer } from 'node:http';
const port = Number(process.argv[2] || 8801);
const mode = process.argv[3] || 'active';
const secret = process.env.FIXTURE_SECRET || 'itsec';
createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname !== '/api/internal/freeze') return json(404, { error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' });
  if (mode === 'reject') return json(403, { error: 'forbidden' });
  const frozen = mode === 'frozen';
  json(200, { frozen, reason: frozen ? 'Account frozen' : null, frozenAt: frozen ? Date.now() : null, unfrozenViaFlow: false });
}).listen(port, '127.0.0.1', () => console.log(`identity fixture on :${port} mode=${mode}`));
