import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PTO_APPROVAL_SECRET = 'test-secret-32-bytes-long-aaaaaa';
process.env.RESEND_API_KEY = 'test';
process.env.OWNER_EMAIL = 'owner@example.com';

function makeRes() {
  let statusCode, body, bodyText;
  return {
    setHeader() {},
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
    send(b) { bodyText = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
    get bodyText() { return bodyText; },
  };
}

test('pto module loads and exports default handler', async () => {
  const mod = await import('../api/pto.js');
  assert.equal(typeof mod.default, 'function');
});

// Admin flow — requires Bearer

test('pto admin: missing bearer falls through to public flow; GET → 405', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: {}, query: { resource: 'employees' } }, res);
  assert.equal(res.statusCode, 405);
});

test('pto admin: wrong-password bearer rejected with 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong-password-len' }, query: { resource: 'employees' } }, res);
  assert.equal(res.statusCode, 401);
});

// Public flow — POST {action, name, ssn4}

test('pto public: rejects missing name with 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'login', name: '', ssn4: '1234' } }, res);
  assert.equal(res.statusCode, 401);
});

test('pto public: rejects bad ssn4 with 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'login', name: 'A', ssn4: 'abcd' } }, res);
  assert.equal(res.statusCode, 401);
});

// Decision magic-link flow — GET with ?token=

test('pto decision: forged token returns 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: {}, query: { token: 'AAAA.BBBB' } }, res);
  assert.equal(res.statusCode, 401);
});
