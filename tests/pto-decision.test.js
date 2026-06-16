import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.PTO_APPROVAL_SECRET = 'test-secret-32-bytes-long-aaaaaa';
process.env.RESEND_API_KEY = 'test';

function makeRes() {
  let statusCode, bodyText;
  return {
    setHeader() {},
    status(c) { statusCode = c; return this; },
    send(b) { bodyText = b; return this; },
    get statusCode() { return statusCode; },
    get bodyText() { return bodyText; },
  };
}

test('pto-decision rejects missing token with 400', async () => {
  const { default: handler } = await import('../api/pto-decision.js');
  const res = makeRes();
  await handler({ query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('pto-decision rejects forged token with 401', async () => {
  const { default: handler } = await import('../api/pto-decision.js');
  const res = makeRes();
  await handler({ query: { token: 'AAAA.BBBB' } }, res);
  assert.equal(res.statusCode, 401);
});

test('pto-decision module loads and exports default handler', async () => {
  const mod = await import('../api/pto-decision.js');
  assert.equal(typeof mod.default, 'function');
});
