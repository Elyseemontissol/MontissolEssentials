import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.PTO_APPROVAL_SECRET = 'test-secret-32-bytes-long-aaaaaa';
process.env.RESEND_API_KEY = 'test';
process.env.OWNER_EMAIL = 'owner@example.com';

function makeRes() {
  let statusCode, body;
  return {
    setHeader() {},
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

test('pto-public rejects non-POST with 405', async () => {
  const { default: handler } = await import('../api/pto-public.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('pto-public 401s on missing name or bad ssn4', async () => {
  const { default: handler } = await import('../api/pto-public.js');
  const r1 = makeRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'login', name: '', ssn4: '1234' } }, r1);
  assert.equal(r1.statusCode, 401);
  const r2 = makeRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'login', name: 'A', ssn4: 'abcd' } }, r2);
  assert.equal(r2.statusCode, 401);
});

test('pto-public module loads and exports default handler', async () => {
  const mod = await import('../api/pto-public.js');
  assert.equal(typeof mod.default, 'function');
});
