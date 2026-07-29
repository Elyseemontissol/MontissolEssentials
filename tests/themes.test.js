import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Lightweight in-memory Redis mock matching the @upstash/redis interface we use.
function makeRedisMock() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); return 'OK'; },
  };
}

let mock;
beforeEach(() => { mock = makeRedisMock(); });

test('getNextTheme returns the first editorial theme on first call', async () => {
  const { getNextTheme } = await import('../api/_lib/themes.js');
  const t = await getNextTheme(mock);
  assert.equal(t, 'business_inspiration');
});

test('advanceTheme cycles through the social editorial themes', async () => {
  const { getNextTheme, advanceTheme } = await import('../api/_lib/themes.js');
  assert.equal(await getNextTheme(mock), 'business_inspiration');
  await advanceTheme(mock);
  assert.equal(await getNextTheme(mock), 'employee_culture');
  await advanceTheme(mock);
  assert.equal(await getNextTheme(mock), 'why_work_here');
  await advanceTheme(mock);
  assert.equal(await getNextTheme(mock), 'recruiting');
  await advanceTheme(mock);
  assert.equal(await getNextTheme(mock), 'business_inspiration');
});

test('getNextTheme is idempotent (does not advance)', async () => {
  const { getNextTheme } = await import('../api/_lib/themes.js');
  assert.equal(await getNextTheme(mock), 'business_inspiration');
  assert.equal(await getNextTheme(mock), 'business_inspiration');
});

test('getNextTheme returns the first theme if redis value is unknown', async () => {
  const { getNextTheme } = await import('../api/_lib/themes.js');
  await mock.set('fb:next_theme', 'garbage');
  assert.equal(await getNextTheme(mock), 'business_inspiration');
});
