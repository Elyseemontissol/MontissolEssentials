import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.ADMIN_PASSWORD = 'correct-password';

function response() {
  let statusCode;
  let body;
  return {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

test('candidate API requires the admin password', async () => {
  const { default: handler } = await import('../api/jobs.js');
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('candidate API rejects unsupported methods before authentication', async () => {
  const { default: handler } = await import('../api/jobs.js');
  const res = response();
  await handler({ method: 'DELETE', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
