import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.RESEND_API_KEY = 'test';

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

test('pto admin rejects missing auth with 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: {}, query: { resource: 'employees' } }, res);
  assert.equal(res.statusCode, 401);
});

test('pto admin rejects wrong password with 401', async () => {
  const { default: handler } = await import('../api/pto.js');
  const res = makeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong-password-len' }, query: { resource: 'employees' } }, res);
  assert.equal(res.statusCode, 401);
});

test('pto admin module loads and exports default handler', async () => {
  const mod = await import('../api/pto.js');
  assert.equal(typeof mod.default, 'function');
});
