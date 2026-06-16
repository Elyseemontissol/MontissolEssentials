import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../api/_lib/pto-tokens.js';

const SECRET = 'test-secret-32-bytes-long-aaaaaa';

test('signToken + verifyToken round-trip', () => {
  const token = signToken('req-123', 'approve', SECRET);
  const payload = verifyToken(token, SECRET);
  assert.deepEqual(payload, { requestId: 'req-123', decision: 'approve' });
});

test('verifyToken rejects forged signature', () => {
  const token = signToken('req-123', 'approve', SECRET);
  const tampered = token.slice(0, -4) + 'AAAA';
  assert.equal(verifyToken(tampered, SECRET), null);
});

test('verifyToken rejects wrong secret', () => {
  const token = signToken('req-123', 'approve', SECRET);
  assert.equal(verifyToken(token, 'different-secret-also-32-bytes-l'), null);
});

test('verifyToken rejects tampered payload with original sig', () => {
  const token = signToken('req-123', 'approve', SECRET);
  const [payload, sig] = token.split('.');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  obj.decision = 'deny';
  const badPayload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  assert.equal(verifyToken(`${badPayload}.${sig}`, SECRET), null);
});

test('verifyToken rejects malformed/non-string tokens', () => {
  assert.equal(verifyToken('not-a-token', SECRET), null);
  assert.equal(verifyToken('', SECRET), null);
  assert.equal(verifyToken('a.b', SECRET), null);
  assert.equal(verifyToken(null, SECRET), null);
  assert.equal(verifyToken(42, SECRET), null);
});

test('signToken throws on missing secret', () => {
  assert.throws(() => signToken('req-1', 'approve', ''));
});

test('verifyToken returns null on missing secret', () => {
  const token = signToken('req-1', 'approve', SECRET);
  assert.equal(verifyToken(token, ''), null);
});

test('approve and deny tokens for same request are different', () => {
  const a = signToken('req-1', 'approve', SECRET);
  const d = signToken('req-1', 'deny', SECRET);
  assert.notEqual(a, d);
});
