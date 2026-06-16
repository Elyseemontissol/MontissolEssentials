import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory sorted-set mock matching the @upstash/redis interface we use.
function makeRedisMock() {
  const store = new Map();
  return {
    async zadd(key, ...args) {
      // tests always pass { score, member }
      const list = store.get(key) || [];
      for (const a of args) list.push({ score: a.score, member: a.member });
      store.set(key, list);
      return 1;
    },
    async zremrangebyscore(key, min, max) {
      const list = store.get(key) || [];
      const filtered = list.filter((e) => !(e.score >= min && e.score <= max));
      store.set(key, filtered);
      return list.length - filtered.length;
    },
    async zrange(key /* , start, stop */) {
      return (store.get(key) || []).map((e) => e.member);
    },
    async del(key) { store.delete(key); return 1; },
  };
}

let mock;
beforeEach(() => { mock = makeRedisMock(); });

test('first 5 attempts allowed, 6th blocked', async () => {
  const { checkAndRecordAttempt } = await import('../api/_lib/pto-rate-limit.js');
  for (let i = 1; i <= 5; i++) {
    const r = await checkAndRecordAttempt(mock, 'k', 5, 900, i * 1000);
    assert.equal(r.allowed, true, `attempt ${i} should be allowed`);
  }
  const sixth = await checkAndRecordAttempt(mock, 'k', 5, 900, 6000);
  assert.equal(sixth.allowed, false);
  assert.ok(sixth.retryAfterSec > 0);
});

test('counter clears after window', async () => {
  const { checkAndRecordAttempt } = await import('../api/_lib/pto-rate-limit.js');
  for (let i = 1; i <= 5; i++) {
    await checkAndRecordAttempt(mock, 'k', 5, 10, i * 1000);
  }
  // jump well past the 10s window
  const later = await checkAndRecordAttempt(mock, 'k', 5, 10, 60000);
  assert.equal(later.allowed, true);
});

test('clearAttempts resets the counter', async () => {
  const { checkAndRecordAttempt, clearAttempts } = await import('../api/_lib/pto-rate-limit.js');
  for (let i = 1; i <= 5; i++) {
    await checkAndRecordAttempt(mock, 'k', 5, 900, i * 1000);
  }
  await clearAttempts(mock, 'k');
  const after = await checkAndRecordAttempt(mock, 'k', 5, 900, 6000);
  assert.equal(after.allowed, true);
});
