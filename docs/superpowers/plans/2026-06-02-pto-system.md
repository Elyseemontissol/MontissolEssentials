# Employee PTO System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-service PTO system: employees sign in with name + last-4 SSN at `/pto.html` to see their balance and submit requests; the owner manages employees and approves/denies requests at `/pto-admin.html`; HMAC-signed magic-links in alert emails let the owner approve from email too.

**Architecture:** Three Vercel serverless functions (`api/pto.js` admin, `api/pto-public.js` employee, `api/pto-decision.js` magic-link) backed by Upstash Redis. SSN-4 stored as bcrypt hash. Approve/Deny is one-time-use across all paths via a shared per-request claim key. Resend handles owner-alert and employee-decision emails.

**Tech Stack:** Node 20 (ES modules) · Vercel serverless · Upstash Redis · Resend · bcryptjs · Node built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-02-pto-system-design.md`

**Working directory:** `MontissolEssentials/` (project root with `package.json`). Branch: `feat/pto-system` (already checked out).

---

## File Structure

**New files:**

| File | Responsibility |
|------|----------------|
| `api/_lib/pto-redis.js` | Shared narrow Redis client + `KEYS` helpers + constants (`ANNUAL_DAYS=5`) |
| `api/_lib/pto-dates.js` | `countWeekdays(start, end)` — pure date helper |
| `api/_lib/pto-tokens.js` | HMAC sign/verify for email magic-links (same pattern as `api/_lib/tokens.js`) |
| `api/_lib/pto-auth.js` | `hashSsn4`, `verifySsn4`, `findEmployee(name, ssn4)` |
| `api/_lib/pto-rate-limit.js` | Sliding-window login attempt counter |
| `api/_lib/pto-store.js` | Employee + request CRUD on top of Redis; lazy-resets balance on access |
| `api/_lib/pto-email.js` | Resend templates + send wrappers (owner alert, employee decision) |
| `api/pto.js` | Admin endpoint — employees CRUD, list/decide requests; bearer auth |
| `api/pto-public.js` | Employee endpoint — login + submit request; no admin auth |
| `api/pto-decision.js` | Email magic-link endpoint — verify token, apply decision |
| `pto.html` | Employee portal page |
| `pto-admin.html` | Admin page |
| `tests/pto-dates.test.js` | Unit tests for `countWeekdays` |
| `tests/pto-tokens.test.js` | Unit tests for HMAC helper |
| `tests/pto-auth.test.js` | Unit tests for `hashSsn4`/`verifySsn4`/`findEmployee` |
| `tests/pto-rate-limit.test.js` | Unit tests for the sliding-window counter |
| `tests/pto-store.test.js` | Unit tests for employee/request CRUD (in-memory Redis mock) |
| `tests/pto-admin.test.js` | Smoke + auth tests for `api/pto.js` |
| `tests/pto-public.test.js` | Smoke + validation tests for `api/pto-public.js` |
| `tests/pto-decision.test.js` | Token-rejection + smoke tests for `api/pto-decision.js` |

**Modified files:**

| File | Change |
|------|--------|
| `package.json` | Add `bcryptjs` dependency |

---

## Task 1: Add the `bcryptjs` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read current package.json**

Run: `cat package.json`

- [ ] **Step 2: Add `bcryptjs`**

Add `"bcryptjs": "^2.4.3"` to the `dependencies` object, keeping all existing entries and alphabetical order:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test 'tests/**/*.test.js'"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@upstash/redis": "^1.37.0",
    "@vercel/blob": "^0.27.0",
    "bcryptjs": "^2.4.3",
    "openai": "^4.80.0",
    "resend": "^4.0.0",
    "stripe": "^17.0.0"
  }
}
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: lockfile updates, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add bcryptjs for PTO ssn4 hashing"
```

---

## Task 2: Shared Redis client + key helpers

**Files:**
- Create: `api/_lib/pto-redis.js`

- [ ] **Step 1: Write the module**

Create `api/_lib/pto-redis.js`:

```js
import { Redis } from '@upstash/redis';

const _client = Redis.fromEnv();

// Narrow interface — only the operations the PTO feature uses.
export const redis = {
  get:      (...args) => _client.get(...args),
  set:      (...args) => _client.set(...args),
  getdel:   (...args) => _client.getdel(...args),
  del:      (...args) => _client.del(...args),
  sadd:     (...args) => _client.sadd(...args),
  srem:     (...args) => _client.srem(...args),
  smembers: (...args) => _client.smembers(...args),
  lpush:    (...args) => _client.lpush(...args),
  lrange:   (...args) => _client.lrange(...args),
  ltrim:    (...args) => _client.ltrim(...args),
  zadd:     (...args) => _client.zadd(...args),
  zrange:   (...args) => _client.zrange(...args),
  zremrangebyscore: (...args) => _client.zremrangebyscore(...args),
};

export const ANNUAL_DAYS = 5;
export const REQUEST_TTL_SECONDS = 72 * 60 * 60;

export const KEYS = {
  employee:        (id) => `pto:employee:${id}`,
  employees:       'pto:employees',
  request:         (id) => `pto:request:${id}`,
  requests:        'pto:requests',
  requestsByEmp:   (employeeId) => `pto:requests:by-employee:${employeeId}`,
  decisionClaim:   (requestId) => `pto:decision-claim:${requestId}`,
  rateLimitLogin:  (nameKey) => `pto:rate:login:${nameKey}`,
  rateLimitIp:     (ip) => `pto:rate:ip:${ip}`,
};

export function normalizeName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/_lib/pto-redis.js
git commit -m "feat(pto): shared redis client, KEYS, and constants"
```

---

## Task 3: `countWeekdays` helper — failing test first

**Files:**
- Create: `tests/pto-dates.test.js`
- Create: `api/_lib/pto-dates.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pto-dates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWeekdays } from '../api/_lib/pto-dates.js';

test('same-day weekday returns 1', () => {
  // 2026-06-15 is a Monday
  assert.equal(countWeekdays('2026-06-15', '2026-06-15'), 1);
});

test('same-day weekend returns 0', () => {
  // 2026-06-13 is a Saturday
  assert.equal(countWeekdays('2026-06-13', '2026-06-13'), 0);
});

test('full Mon-Fri returns 5', () => {
  // Mon 2026-06-15 to Fri 2026-06-19
  assert.equal(countWeekdays('2026-06-15', '2026-06-19'), 5);
});

test('Mon to following Mon returns 6 (skips Sat+Sun)', () => {
  // Mon 2026-06-15 to Mon 2026-06-22
  assert.equal(countWeekdays('2026-06-15', '2026-06-22'), 6);
});

test('Sat to Sun returns 0', () => {
  assert.equal(countWeekdays('2026-06-13', '2026-06-14'), 0);
});

test('Fri to Mon returns 2 (Fri + Mon, skip weekend)', () => {
  // Fri 2026-06-19 to Mon 2026-06-22
  assert.equal(countWeekdays('2026-06-19', '2026-06-22'), 2);
});

test('end before start throws', () => {
  assert.throws(() => countWeekdays('2026-06-19', '2026-06-15'));
});

test('invalid date format throws', () => {
  assert.throws(() => countWeekdays('not-a-date', '2026-06-15'));
  assert.throws(() => countWeekdays('2026-06-15', 'bad'));
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test`
Expected: `pto-dates.test.js` fails because `../api/_lib/pto-dates.js` doesn't exist; other tests still pass.

- [ ] **Step 3: Implement the helper**

Create `api/_lib/pto-dates.js`:

```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseISODate(s) {
  if (!DATE_RE.test(s)) throw new Error(`Invalid date: ${s}`);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function countWeekdays(startDate, endDate) {
  const start = parseISODate(startDate);
  const end = parseISODate(endDate);
  if (end < start) throw new Error('End date must be on or after start date.');
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all 8 date tests pass; all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/pto-dates.js tests/pto-dates.test.js
git commit -m "feat(pto): countWeekdays date helper"
```

---

## Task 4: HMAC magic-link tokens — failing test first

**Files:**
- Create: `tests/pto-tokens.test.js`
- Create: `api/_lib/pto-tokens.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pto-tokens.test.js`:

```js
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
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test`
Expected: `pto-tokens.test.js` fails — module not found.

- [ ] **Step 3: Implement the helper**

Create `api/_lib/pto-tokens.js`:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

export function signToken(requestId, decision, secret) {
  if (!secret) throw new TypeError('signToken: secret is required');
  const payload = b64url(JSON.stringify({ requestId, decision }));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = b64url(createHmac('sha256', secret).update(payload).digest());
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(fromB64url(payload).toString('utf8'));
    if (typeof obj.requestId !== 'string' || typeof obj.decision !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all 8 token tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/pto-tokens.js tests/pto-tokens.test.js
git commit -m "feat(pto): HMAC magic-link tokens for email approve/deny"
```

---

## Task 5: SSN-4 hash + employee lookup — failing test first

**Files:**
- Create: `tests/pto-auth.test.js`
- Create: `api/_lib/pto-auth.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pto-auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSsn4, verifySsn4, findEmployee } from '../api/_lib/pto-auth.js';

test('hashSsn4 rejects non-4-digit input', async () => {
  await assert.rejects(() => hashSsn4('123'));
  await assert.rejects(() => hashSsn4('12345'));
  await assert.rejects(() => hashSsn4('abcd'));
  await assert.rejects(() => hashSsn4(''));
  await assert.rejects(() => hashSsn4(null));
});

test('hashSsn4 + verifySsn4 round-trip', async () => {
  const hash = await hashSsn4('4567');
  assert.equal(await verifySsn4('4567', hash), true);
  assert.equal(await verifySsn4('4568', hash), false);
});

test('same ssn4 hashed twice produces different hashes (salted)', async () => {
  const a = await hashSsn4('4567');
  const b = await hashSsn4('4567');
  assert.notEqual(a, b);
  assert.equal(await verifySsn4('4567', a), true);
  assert.equal(await verifySsn4('4567', b), true);
});

test('verifySsn4 returns false on invalid hash', async () => {
  assert.equal(await verifySsn4('4567', 'not-a-bcrypt-hash'), false);
});

test('findEmployee matches by normalized name + valid ssn4', async () => {
  const e1 = { id: '1', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('4567') };
  const e2 = { id: '2', name: 'Maria Lopez', nameKey: 'maria lopez', ssn4Hash: await hashSsn4('1234') };
  const employees = [e1, e2];
  const match = await findEmployee('  John Smith  ', '4567', employees);
  assert.equal(match.id, '1');
});

test('findEmployee is case- and whitespace-insensitive', async () => {
  const e = { id: '1', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('4567') };
  const match = await findEmployee('JOHN  smith', '4567', [e]);
  assert.equal(match.id, '1');
});

test('findEmployee returns null on wrong ssn4 even when name matches', async () => {
  const e = { id: '1', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('4567') };
  const match = await findEmployee('John Smith', '9999', [e]);
  assert.equal(match, null);
});

test('findEmployee returns null on unknown name', async () => {
  const e = { id: '1', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('4567') };
  assert.equal(await findEmployee('Nobody', '4567', [e]), null);
});

test('findEmployee same-name collision: returns the one whose ssn4 verifies', async () => {
  const e1 = { id: '1', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('1111') };
  const e2 = { id: '2', name: 'John Smith', nameKey: 'john smith', ssn4Hash: await hashSsn4('2222') };
  const match = await findEmployee('John Smith', '2222', [e1, e2]);
  assert.equal(match.id, '2');
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test`
Expected: `pto-auth.test.js` fails — module not found.

- [ ] **Step 3: Implement the helper**

Create `api/_lib/pto-auth.js`:

```js
import bcrypt from 'bcryptjs';
import { normalizeName } from './pto-redis.js';

const SSN4_RE = /^\d{4}$/;
const BCRYPT_ROUNDS = 10;

export async function hashSsn4(ssn4) {
  if (typeof ssn4 !== 'string' || !SSN4_RE.test(ssn4)) {
    throw new Error('ssn4 must be exactly 4 digits.');
  }
  return bcrypt.hash(ssn4, BCRYPT_ROUNDS);
}

export async function verifySsn4(ssn4, hash) {
  if (typeof ssn4 !== 'string' || typeof hash !== 'string') return false;
  try {
    return await bcrypt.compare(ssn4, hash);
  } catch {
    return false;
  }
}

export async function findEmployee(name, ssn4, employees) {
  const key = normalizeName(name);
  if (!key || !ssn4) return null;
  for (const emp of employees) {
    if (emp.nameKey !== key) continue;
    if (await verifySsn4(ssn4, emp.ssn4Hash)) return emp;
  }
  return null;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all 9 auth tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/pto-auth.js tests/pto-auth.test.js
git commit -m "feat(pto): bcrypt ssn4 hashing and employee lookup"
```

---

## Task 6: Rate-limit helper — failing test first

**Files:**
- Create: `tests/pto-rate-limit.test.js`
- Create: `api/_lib/pto-rate-limit.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pto-rate-limit.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory sorted-set mock matching the @upstash/redis interface we use.
function makeRedisMock() {
  const store = new Map();
  return {
    async zadd(key, ...args) {
      // accepts { score, member } objects OR (score, member) pairs depending on version;
      // tests always pass { score, member }.
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
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test`
Expected: `pto-rate-limit.test.js` fails — module not found.

- [ ] **Step 3: Implement the helper**

Create `api/_lib/pto-rate-limit.js`:

```js
// Sliding-window rate limiter using a Redis sorted set.
// Each attempt is added with its timestamp as the score; we prune
// entries older than `windowSeconds` and count what remains.

export async function checkAndRecordAttempt(redis, key, max, windowSeconds, nowMs = Date.now()) {
  const windowMs = windowSeconds * 1000;
  const cutoff = nowMs - windowMs;
  await redis.zremrangebyscore(key, 0, cutoff);
  const current = await redis.zrange(key, 0, -1);
  if (current.length >= max) {
    return { allowed: false, remaining: 0, retryAfterSec: windowSeconds };
  }
  await redis.zadd(key, { score: nowMs, member: `${nowMs}-${Math.random()}` });
  return { allowed: true, remaining: max - current.length - 1, retryAfterSec: 0 };
}

export async function clearAttempts(redis, key) {
  await redis.del(key);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all 3 rate-limit tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/pto-rate-limit.js tests/pto-rate-limit.test.js
git commit -m "feat(pto): sliding-window login rate limiter"
```

---

## Task 7: Store — employee + request CRUD with lazy balance reset

**Files:**
- Create: `tests/pto-store.test.js`
- Create: `api/_lib/pto-store.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pto-store.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeRedisMock() {
  const kv = new Map();
  const sets = new Map();
  const lists = new Map();
  return {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); return 'OK'; },
    async del(k) { kv.delete(k); return 1; },
    async getdel(k) { const v = kv.has(k) ? kv.get(k) : null; kv.delete(k); return v; },
    async sadd(k, ...members) {
      const s = sets.get(k) || new Set();
      members.forEach((m) => s.add(m));
      sets.set(k, s);
      return members.length;
    },
    async srem(k, member) {
      const s = sets.get(k);
      if (s) s.delete(member);
      return 1;
    },
    async smembers(k) { return Array.from(sets.get(k) || []); },
    async lpush(k, v) {
      const l = lists.get(k) || [];
      l.unshift(v);
      lists.set(k, l);
      return l.length;
    },
    async lrange(k, start, stop) {
      const l = lists.get(k) || [];
      const end = stop === -1 ? l.length : stop + 1;
      return l.slice(start, end);
    },
    async ltrim(k, start, stop) {
      const l = lists.get(k) || [];
      const end = stop === -1 ? l.length : stop + 1;
      lists.set(k, l.slice(start, end));
      return 'OK';
    },
  };
}

let mock;
beforeEach(() => { mock = makeRedisMock(); });

test('createEmployee writes record, adds to set, balance=5', async () => {
  const { createEmployee, listEmployees } = await import('../api/_lib/pto-store.js');
  const emp = await createEmployee(mock, { name: 'John Smith', email: 'j@x.com', ssn4: '4567' }, 2026);
  assert.equal(emp.balanceDays, 5);
  assert.equal(emp.lastResetYear, 2026);
  assert.equal(emp.nameKey, 'john smith');
  assert.ok(emp.ssn4Hash.startsWith('$2'));
  const list = await listEmployees(mock, 2026);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, emp.id);
});

test('listEmployees lazy-resets balance when year rolls over', async () => {
  const { createEmployee, listEmployees } = await import('../api/_lib/pto-store.js');
  const emp = await createEmployee(mock, { name: 'A B', email: 'a@b.com', ssn4: '1111' }, 2026);
  // mutate balance directly via store helpers...
  const { adjustBalance } = await import('../api/_lib/pto-store.js');
  await adjustBalance(mock, emp.id, 1, 'used');
  let list = await listEmployees(mock, 2026);
  assert.equal(list[0].balanceDays, 1);
  list = await listEmployees(mock, 2027);
  assert.equal(list[0].balanceDays, 5);
  assert.equal(list[0].lastResetYear, 2027);
});

test('deleteEmployee removes from set and key', async () => {
  const { createEmployee, deleteEmployee, listEmployees } = await import('../api/_lib/pto-store.js');
  const e = await createEmployee(mock, { name: 'X Y', email: 'x@y.com', ssn4: '0000' }, 2026);
  await deleteEmployee(mock, e.id);
  const list = await listEmployees(mock, 2026);
  assert.equal(list.length, 0);
});

test('createRequest validates and stores pending', async () => {
  const { createEmployee, createRequest, listEmployeeRequests } = await import('../api/_lib/pto-store.js');
  const e = await createEmployee(mock, { name: 'X Y', email: 'x@y.com', ssn4: '0000' }, 2026);
  const req = await createRequest(mock, {
    employee: e,
    startDate: '2026-06-15', endDate: '2026-06-17',
    reason: 'Vacation',
  });
  assert.equal(req.status, 'pending');
  assert.equal(req.days, 3);
  assert.equal(req.employeeName, 'X Y');
  const history = await listEmployeeRequests(mock, e.id);
  assert.equal(history.length, 1);
});

test('createRequest rejects when days exceed balance', async () => {
  const { createEmployee, createRequest, adjustBalance } = await import('../api/_lib/pto-store.js');
  const e = await createEmployee(mock, { name: 'X Y', email: 'x@y.com', ssn4: '0000' }, 2026);
  await adjustBalance(mock, e.id, 4, 'used'); // balance now 1
  await assert.rejects(() => createRequest(mock, {
    employee: { ...e, balanceDays: 1 },
    startDate: '2026-06-15', endDate: '2026-06-19', // 5 days
    reason: 'Too much',
  }), /exceed/i);
});

test('decideRequest approve decrements balance', async () => {
  const { createEmployee, createRequest, decideRequest, getEmployee } = await import('../api/_lib/pto-store.js');
  const e = await createEmployee(mock, { name: 'X Y', email: 'x@y.com', ssn4: '0000' }, 2026);
  const r = await createRequest(mock, {
    employee: e, startDate: '2026-06-15', endDate: '2026-06-17', reason: 'V',
  });
  await decideRequest(mock, r.id, 'approve', null);
  const e2 = await getEmployee(mock, e.id, 2026);
  assert.equal(e2.balanceDays, 5 - 3);
});

test('decideRequest deny does not change balance', async () => {
  const { createEmployee, createRequest, decideRequest, getEmployee } = await import('../api/_lib/pto-store.js');
  const e = await createEmployee(mock, { name: 'X Y', email: 'x@y.com', ssn4: '0000' }, 2026);
  const r = await createRequest(mock, {
    employee: e, startDate: '2026-06-15', endDate: '2026-06-17', reason: 'V',
  });
  await decideRequest(mock, r.id, 'deny', 'no thanks');
  const e2 = await getEmployee(mock, e.id, 2026);
  assert.equal(e2.balanceDays, 5);
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test`
Expected: `pto-store.test.js` fails — module not found.

- [ ] **Step 3: Implement the store**

Create `api/_lib/pto-store.js`:

```js
import { randomUUID } from 'node:crypto';
import { KEYS, ANNUAL_DAYS, REQUEST_TTL_SECONDS, normalizeName } from './pto-redis.js';
import { hashSsn4 } from './pto-auth.js';
import { countWeekdays } from './pto-dates.js';

const REQUEST_HISTORY_CAP = 50;
const GLOBAL_REQUEST_CAP = 200;

function maybeReset(employee, currentYear) {
  if (employee.lastResetYear === currentYear) return employee;
  return { ...employee, balanceDays: ANNUAL_DAYS, lastResetYear: currentYear };
}

export async function getEmployee(redis, id, currentYear) {
  const raw = await redis.get(KEYS.employee(id));
  if (!raw) return null;
  const emp = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const after = maybeReset(emp, currentYear);
  if (after.lastResetYear !== emp.lastResetYear) {
    await redis.set(KEYS.employee(id), JSON.stringify(after));
  }
  return after;
}

export async function listEmployees(redis, currentYear) {
  const ids = await redis.smembers(KEYS.employees);
  const out = [];
  for (const id of ids) {
    const emp = await getEmployee(redis, id, currentYear);
    if (emp) out.push(emp);
  }
  return out;
}

export async function createEmployee(redis, { name, email, ssn4 }, currentYear) {
  if (!name || !email) throw new Error('Name and email are required.');
  const id = randomUUID();
  const emp = {
    id,
    name: String(name).trim(),
    nameKey: normalizeName(name),
    email: String(email).trim(),
    ssn4Hash: await hashSsn4(ssn4),
    balanceDays: ANNUAL_DAYS,
    lastResetYear: currentYear,
    createdAt: new Date().toISOString(),
  };
  await redis.set(KEYS.employee(id), JSON.stringify(emp));
  await redis.sadd(KEYS.employees, id);
  return emp;
}

export async function updateEmployee(redis, id, updates, currentYear) {
  const emp = await getEmployee(redis, id, currentYear);
  if (!emp) throw new Error('Employee not found.');
  const next = { ...emp };
  if (updates.name !== undefined) {
    next.name = String(updates.name).trim();
    next.nameKey = normalizeName(updates.name);
  }
  if (updates.email !== undefined) next.email = String(updates.email).trim();
  if (updates.ssn4 !== undefined) next.ssn4Hash = await hashSsn4(updates.ssn4);
  await redis.set(KEYS.employee(id), JSON.stringify(next));
  return next;
}

export async function deleteEmployee(redis, id) {
  await redis.del(KEYS.employee(id));
  await redis.srem(KEYS.employees, id);
}

export async function adjustBalance(redis, id, deltaOrSet, mode /* 'used' | 'set' */) {
  const raw = await redis.get(KEYS.employee(id));
  if (!raw) throw new Error('Employee not found.');
  const emp = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (mode === 'used') {
    emp.balanceDays = Math.max(0, emp.balanceDays - deltaOrSet);
  } else if (mode === 'set') {
    emp.balanceDays = Math.max(0, deltaOrSet);
  } else {
    throw new Error('mode must be "used" or "set"');
  }
  await redis.set(KEYS.employee(id), JSON.stringify(emp));
  return emp;
}

export async function createRequest(redis, { employee, startDate, endDate, reason }) {
  const days = countWeekdays(startDate, endDate);
  if (days <= 0) throw new Error('Request must include at least one weekday.');
  if (days > employee.balanceDays) {
    throw new Error(`Requested ${days} day(s) exceed your remaining balance of ${employee.balanceDays}.`);
  }
  if (!reason || !String(reason).trim()) throw new Error('Reason is required.');
  const id = randomUUID();
  const req = {
    id,
    employeeId: employee.id,
    employeeName: employee.name,
    startDate,
    endDate,
    days,
    reason: String(reason).trim().slice(0, 500),
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decisionNote: null,
  };
  await redis.set(KEYS.request(id), JSON.stringify(req));
  await redis.set(KEYS.decisionClaim(id), 'unused', { ex: REQUEST_TTL_SECONDS });
  await redis.lpush(KEYS.requests, id);
  await redis.ltrim(KEYS.requests, 0, GLOBAL_REQUEST_CAP - 1);
  await redis.lpush(KEYS.requestsByEmp(employee.id), id);
  await redis.ltrim(KEYS.requestsByEmp(employee.id), 0, REQUEST_HISTORY_CAP - 1);
  return req;
}

export async function getRequest(redis, id) {
  const raw = await redis.get(KEYS.request(id));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function decideRequest(redis, requestId, decision, note) {
  if (decision !== 'approve' && decision !== 'deny') {
    throw new Error('decision must be "approve" or "deny"');
  }
  const claim = await redis.getdel(KEYS.decisionClaim(requestId));
  if (!claim) throw new Error('Already decided or expired.');
  const req = await getRequest(redis, requestId);
  if (!req) throw new Error('Request not found.');
  req.status = decision === 'approve' ? 'approved' : 'denied';
  req.decidedAt = new Date().toISOString();
  req.decisionNote = note ? String(note).slice(0, 500) : null;
  await redis.set(KEYS.request(requestId), JSON.stringify(req));
  if (decision === 'approve') {
    await adjustBalance(redis, req.employeeId, req.days, 'used');
  }
  return req;
}

export async function listRequests(redis, { status, limit = 50 } = {}) {
  const ids = await redis.lrange(KEYS.requests, 0, limit - 1);
  const out = [];
  for (const id of ids) {
    const r = await getRequest(redis, id);
    if (!r) continue;
    if (status && r.status !== status) continue;
    out.push(r);
  }
  return out;
}

export async function listEmployeeRequests(redis, employeeId, limit = REQUEST_HISTORY_CAP) {
  const ids = await redis.lrange(KEYS.requestsByEmp(employeeId), 0, limit - 1);
  const out = [];
  for (const id of ids) {
    const r = await getRequest(redis, id);
    if (r) out.push(r);
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all 7 store tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/pto-store.js tests/pto-store.test.js
git commit -m "feat(pto): employee + request store with lazy balance reset"
```

---

## Task 8: Email templates + Resend wrappers

**Files:**
- Create: `api/_lib/pto-email.js`

No unit tests — thin wrapper around Resend, covered by the manual end-to-end test.

- [ ] **Step 1: Write the module**

Create `api/_lib/pto-email.js`:

```js
import { Resend } from 'resend';

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function btn(href, label, bg) {
  return `<a href="${href}" style="display:inline-block;padding:10px 18px;background:${bg};color:#fff;border-radius:6px;text-decoration:none;margin-right:8px;font-weight:600;">${label}</a>`;
}

export function renderOwnerAlertEmail({ request, approveUrl, denyUrl, currentBalance }) {
  const wouldBe = Math.max(0, currentBalance - request.days);
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;margin:auto;padding:24px;">
      <h2 style="margin:0 0 8px 0;">PTO request: ${escapeHtml(request.employeeName)}</h2>
      <p style="color:#666;margin:0 0 16px 0;">Request ID ${escapeHtml(request.id)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr><td style="padding:6px 0;color:#666;">Dates</td><td style="padding:6px 0;"><strong>${escapeHtml(request.startDate)} – ${escapeHtml(request.endDate)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Days</td><td style="padding:6px 0;"><strong>${request.days}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Balance</td><td style="padding:6px 0;">${currentBalance} → would be <strong>${wouldBe}</strong> if approved</td></tr>
        <tr><td style="padding:6px 0;color:#666;vertical-align:top;">Reason</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(request.reason)}</td></tr>
      </table>
      <div style="margin-top:24px;">
        ${btn(approveUrl, '✅ Approve', '#16a34a')}
        ${btn(denyUrl, '❌ Deny', '#dc2626')}
      </div>
      <p style="color:#999;font-size:12px;margin-top:24px;">Links expire in 72 hours. One-time use — clicking Approve or Deny disables the other for this request.</p>
    </div>
  `;
}

export function renderEmployeeDecisionEmail({ request, decision, newBalance }) {
  if (decision === 'approve') {
    return `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;">
        <h2 style="color:#16a34a;margin:0 0 12px 0;">PTO approved ✓</h2>
        <p>Your PTO request for <strong>${escapeHtml(request.startDate)} – ${escapeHtml(request.endDate)}</strong> (${request.days} day${request.days === 1 ? '' : 's'}) has been approved.</p>
        <p>Your new PTO balance: <strong>${newBalance} day${newBalance === 1 ? '' : 's'}</strong>.</p>
        <p style="color:#666;margin-top:24px;">— Montissol Essentials</p>
      </div>
    `;
  }
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;">
      <h2 style="color:#dc2626;margin:0 0 12px 0;">PTO request not approved</h2>
      <p>Your PTO request for <strong>${escapeHtml(request.startDate)} – ${escapeHtml(request.endDate)}</strong> (${request.days} day${request.days === 1 ? '' : 's'}) was not approved.</p>
      ${request.decisionNote ? `<p style="background:#fef3c7;padding:12px;border-radius:6px;">Note: ${escapeHtml(request.decisionNote)}</p>` : ''}
      <p>You can submit a different request through the employee portal. Your PTO balance was not changed.</p>
      <p style="color:#666;margin-top:24px;">— Montissol Essentials</p>
    </div>
  `;
}

export async function sendOwnerAlert({ apiKey, to, subject, html }) {
  const resend = new Resend(apiKey);
  return resend.emails.send({
    from: 'Montissol PTO <noreply@montissolessentials.com>',
    to, subject, html,
  });
}

export async function sendEmployeeDecision({ apiKey, to, subject, html }) {
  const resend = new Resend(apiKey);
  return resend.emails.send({
    from: 'Montissol PTO <noreply@montissolessentials.com>',
    to, subject, html,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add api/_lib/pto-email.js
git commit -m "feat(pto): owner alert + employee decision email templates"
```

---

## Task 9: `/api/pto-public.js` — employee endpoint

**Files:**
- Create: `api/pto-public.js`

- [ ] **Step 1: Write the endpoint**

Create `api/pto-public.js`:

```js
import { redis, KEYS } from './_lib/pto-redis.js';
import { findEmployee } from './_lib/pto-auth.js';
import { listEmployees, listEmployeeRequests, createRequest } from './_lib/pto-store.js';
import { signToken } from './_lib/pto-tokens.js';
import { renderOwnerAlertEmail, sendOwnerAlert } from './_lib/pto-email.js';
import { checkAndRecordAttempt, clearAttempts } from './_lib/pto-rate-limit.js';
import { normalizeName } from './_lib/pto-redis.js';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SEC = 900; // 15 min
const IP_MAX_ATTEMPTS = 30;
const GENERIC_AUTH_ERROR = 'Sign-in failed. Check your name and last 4 of SSN.';

function appBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://montissolessentials.com';
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function actionUrls(requestId, secret) {
  const base = appBaseUrl();
  return {
    approveUrl: `${base}/api/pto-decision?token=${signToken(requestId, 'approve', secret)}`,
    denyUrl:    `${base}/api/pto-decision?token=${signToken(requestId, 'deny', secret)}`,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const body = req.body || {};
  const action = body.action;
  const name = String(body.name || '').trim();
  const ssn4 = String(body.ssn4 || '').trim();
  const nameKey = normalizeName(name);
  if (!nameKey || !/^\d{4}$/.test(ssn4)) {
    return res.status(401).json({ ok: false, error: GENERIC_AUTH_ERROR });
  }

  const year = new Date().getUTCFullYear();
  const employees = await listEmployees(redis, year);

  // Rate limit per name + per IP (login + request both gated).
  const ip = clientIp(req);
  const nameGate = await checkAndRecordAttempt(redis, KEYS.rateLimitLogin(nameKey), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SEC);
  if (!nameGate.allowed) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }
  const ipGate = await checkAndRecordAttempt(redis, KEYS.rateLimitIp(ip), IP_MAX_ATTEMPTS, LOGIN_WINDOW_SEC);
  if (!ipGate.allowed) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }

  const employee = await findEmployee(name, ssn4, employees);
  if (!employee) {
    return res.status(401).json({ ok: false, error: GENERIC_AUTH_ERROR });
  }
  await clearAttempts(redis, KEYS.rateLimitLogin(nameKey));

  if (action === 'login') {
    const history = await listEmployeeRequests(redis, employee.id);
    return res.status(200).json({
      ok: true,
      employee: { id: employee.id, name: employee.name, balanceDays: employee.balanceDays },
      history,
    });
  }

  if (action === 'request') {
    let request;
    try {
      request = await createRequest(redis, {
        employee,
        startDate: String(body.startDate || '').trim(),
        endDate: String(body.endDate || '').trim(),
        reason: String(body.reason || '').trim(),
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    try {
      const urls = actionUrls(request.id, process.env.PTO_APPROVAL_SECRET);
      const html = renderOwnerAlertEmail({
        request,
        ...urls,
        currentBalance: employee.balanceDays,
      });
      await sendOwnerAlert({
        apiKey: process.env.RESEND_API_KEY,
        to: process.env.OWNER_EMAIL,
        subject: `PTO request: ${employee.name} — ${request.startDate} to ${request.endDate} (${request.days} d)`,
        html,
      });
    } catch (err) {
      console.error('Owner alert email failed:', err.message);
    }
    return res.status(200).json({ ok: true, requestId: request.id });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
```

- [ ] **Step 2: Smoke test**

Create `tests/pto-public.test.js`:

```js
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
```

- [ ] **Step 3: Run tests, verify pass**

Run: `npm test`
Expected: all 3 pto-public tests pass; all earlier tests still pass.

- [ ] **Step 4: Commit**

```bash
git add api/pto-public.js tests/pto-public.test.js
git commit -m "feat(pto): public employee endpoint (login + submit request)"
```

---

## Task 10: `/api/pto.js` — admin endpoint

**Files:**
- Create: `api/pto.js`

- [ ] **Step 1: Write the endpoint**

Create `api/pto.js`:

```js
import crypto from 'node:crypto';
import { redis, KEYS } from './_lib/pto-redis.js';
import {
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  adjustBalance, listRequests, getRequest, decideRequest, getEmployee,
} from './_lib/pto-store.js';
import { renderEmployeeDecisionEmail, sendEmployeeDecision } from './_lib/pto-email.js';

async function getAdminPassword() {
  try {
    const stored = await redis.get('admin:password');
    if (stored) return stored;
  } catch {}
  return process.env.ADMIN_PASSWORD;
}

async function checkAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  const pwd = await getAdminPassword();
  if (!pwd || !token) return false;
  if (token.length !== pwd.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pwd));
  } catch {
    return false;
  }
}

async function emailEmployeeDecision(request, employee, decision) {
  try {
    // `employee` is fetched AFTER decideRequest, so balanceDays already reflects
    // the (possibly decremented) post-decision value.
    const html = renderEmployeeDecisionEmail({ request, decision, newBalance: employee.balanceDays });
    await sendEmployeeDecision({
      apiKey: process.env.RESEND_API_KEY,
      to: employee.email,
      subject: decision === 'approve'
        ? `PTO approved: ${request.startDate} to ${request.endDate}`
        : 'PTO request not approved',
      html,
    });
  } catch (err) {
    console.error('Employee decision email failed:', err.message);
  }
}

export default async function handler(req, res) {
  if (!(await checkAuth(req))) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { method } = req;
  const resource = req.query?.resource;
  const id = req.query?.id;
  const year = new Date().getUTCFullYear();
  const body = req.body || {};

  try {
    if (resource === 'employees') {
      if (method === 'GET') {
        const employees = await listEmployees(redis, year);
        return res.status(200).json({ ok: true, employees: employees.map(({ ssn4Hash, ...rest }) => rest) });
      }
      if (method === 'POST') {
        const emp = await createEmployee(redis, body, year);
        const { ssn4Hash, ...safe } = emp;
        return res.status(200).json({ ok: true, employee: safe });
      }
      if (method === 'PATCH' && id) {
        if (body.balanceDays !== undefined) {
          const emp = await adjustBalance(redis, id, Number(body.balanceDays), 'set');
          const { ssn4Hash, ...safe } = emp;
          return res.status(200).json({ ok: true, employee: safe });
        }
        const emp = await updateEmployee(redis, id, body, year);
        const { ssn4Hash, ...safe } = emp;
        return res.status(200).json({ ok: true, employee: safe });
      }
      if (method === 'DELETE' && id) {
        await deleteEmployee(redis, id);
        return res.status(200).json({ ok: true });
      }
    }

    if (resource === 'requests' && method === 'GET') {
      const status = req.query?.status;
      const requests = await listRequests(redis, { status });
      return res.status(200).json({ ok: true, requests });
    }

    if (resource === 'decide' && method === 'POST' && id) {
      const decision = body.decision;
      const note = body.note;
      const request = await getRequest(redis, id);
      if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
      const employee = await getEmployee(redis, request.employeeId, year);
      try {
        const updated = await decideRequest(redis, id, decision, note);
        const after = employee ? await getEmployee(redis, request.employeeId, year) : null;
        if (employee) await emailEmployeeDecision(updated, after || employee, decision);
        return res.status(200).json({ ok: true, request: updated });
      } catch (err) {
        const msg = err.message || 'Decide failed';
        const code = /already decided/i.test(msg) ? 410 : 400;
        return res.status(code).json({ ok: false, error: msg });
      }
    }

    return res.status(404).json({ ok: false, error: 'Unknown resource' });
  } catch (err) {
    console.error('pto admin endpoint failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
```

- [ ] **Step 2: Smoke test**

Create `tests/pto-admin.test.js`:

```js
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
```

- [ ] **Step 3: Run tests, verify pass**

Run: `npm test`
Expected: all 3 admin tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/pto.js tests/pto-admin.test.js
git commit -m "feat(pto): admin endpoint (employees CRUD + decide)"
```

---

## Task 11: `/api/pto-decision.js` — magic-link endpoint

**Files:**
- Create: `api/pto-decision.js`

- [ ] **Step 1: Write the endpoint**

Create `api/pto-decision.js`:

```js
import { redis } from './_lib/pto-redis.js';
import { verifyToken } from './_lib/pto-tokens.js';
import { decideRequest, getRequest, getEmployee } from './_lib/pto-store.js';
import { renderEmployeeDecisionEmail, sendEmployeeDecision } from './_lib/pto-email.js';

function htmlPage(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:48px auto;padding:24px;color:#111;}
      .ok{color:#16a34a;} .err{color:#dc2626;}</style>
      </head><body>${body}</body></html>`,
  };
}

function send(res, page) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(page.status).send(page.html);
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default async function handler(req, res) {
  const token = req.query?.token;
  if (!token) return send(res, htmlPage('Missing token', '<h1 class="err">Missing token</h1>', 400));

  const payload = verifyToken(token, process.env.PTO_APPROVAL_SECRET);
  if (!payload) return send(res, htmlPage('Invalid token', '<h1 class="err">Invalid or forged token</h1>', 401));

  const { requestId, decision } = payload;
  const year = new Date().getUTCFullYear();

  try {
    const updated = await decideRequest(redis, requestId, decision, null);
    const employee = await getEmployee(redis, updated.employeeId, year);
    if (employee) {
      try {
        const html = renderEmployeeDecisionEmail({
          request: updated, decision, newBalance: employee.balanceDays,
        });
        await sendEmployeeDecision({
          apiKey: process.env.RESEND_API_KEY,
          to: employee.email,
          subject: decision === 'approve'
            ? `PTO approved: ${updated.startDate} to ${updated.endDate}`
            : 'PTO request not approved',
          html,
        });
      } catch (err) {
        console.error('Employee email failed:', err.message);
      }
    }
    const label = decision === 'approve' ? 'Approved ✓' : 'Denied';
    return send(res, htmlPage(label,
      `<h1 class="${decision === 'approve' ? 'ok' : 'err'}">${label}</h1>
       <p>Request for <strong>${escape(updated.employeeName)}</strong>, ${escape(updated.startDate)} – ${escape(updated.endDate)} (${updated.days} d).</p>
       <p>The employee has been emailed.</p>`));
  } catch (err) {
    const msg = err.message || 'Decide failed';
    if (/already decided/i.test(msg)) {
      return send(res, htmlPage('Already decided',
        '<h1 class="err">Already decided or expired</h1><p>This link can only be used once. Check the admin portal for the final decision.</p>', 410));
    }
    if (/not found/i.test(msg)) {
      return send(res, htmlPage('Not found', '<h1 class="err">Request not found</h1>', 404));
    }
    return send(res, htmlPage('Error',
      `<h1 class="err">Decision failed</h1><pre>${escape(msg)}</pre>`, 500));
  }
}
```

- [ ] **Step 2: Smoke test**

Create `tests/pto-decision.test.js`:

```js
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
```

- [ ] **Step 3: Run tests, verify pass**

Run: `npm test`
Expected: all 3 decision tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/pto-decision.js tests/pto-decision.test.js
git commit -m "feat(pto): email magic-link decision endpoint"
```

---

## Task 12: `pto.html` — employee portal

**Files:**
- Create: `pto.html`

This is the public-facing employee page. Keep the visual style simple — match the dark theme used elsewhere on the site by reusing the same root CSS variables from the existing pages. The whole file is one self-contained HTML + inline JS module.

- [ ] **Step 1: Write the page**

Create `pto.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Employee Time Off — Montissol Essentials</title>
  <meta name="robots" content="noindex">
  <style>
    :root{
      --bg:#0a0a0a; --card:#141414; --text:#f1f1f1; --text-muted:#888;
      --border:#2a2a2a; --brand:#e74d10; --radius:10px;
    }
    *{box-sizing:border-box;}
    body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",sans-serif;line-height:1.5;}
    main{max-width:680px;margin:48px auto;padding:24px;}
    h1{margin:0 0 8px 0;font-size:1.6rem;}
    h2{margin:24px 0 12px 0;font-size:1.2rem;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px;}
    label{display:block;font-size:.85rem;color:var(--text-muted);margin-bottom:6px;}
    input,textarea{width:100%;padding:10px 12px;background:#0a0a0a;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:.95rem;}
    textarea{min-height:80px;resize:vertical;}
    button{padding:12px 24px;background:var(--brand);color:#fff;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;}
    button:disabled{opacity:.5;cursor:not-allowed;}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    .field{margin-bottom:12px;}
    .err{color:#f87171;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:10px 14px;margin-bottom:12px;display:none;}
    .balance{font-size:1.5rem;font-weight:700;color:var(--brand);}
    .balance-sub{font-size:.85rem;color:var(--text-muted);}
    .req{list-style:none;padding:0;margin:0;}
    .req li{padding:10px 0;border-top:1px solid var(--border);font-size:.9rem;}
    .req li:first-child{border-top:none;}
    .status-pending{color:#fbbf24;}
    .status-approved{color:#22c55e;}
    .status-denied{color:#f87171;}
    .note{font-size:.8rem;color:var(--text-muted);font-style:italic;margin-top:4px;}
    .hidden{display:none;}
  </style>
</head>
<body>
<main>

  <!-- Sign-in screen -->
  <section id="signinView" class="card">
    <h1>Employee Time Off</h1>
    <p style="color:var(--text-muted);margin:0 0 16px 0;">Sign in to request paid time off.</p>
    <div id="signinErr" class="err"></div>
    <div class="field">
      <label for="siName">Full name</label>
      <input id="siName" type="text" autocomplete="off">
    </div>
    <div class="field">
      <label for="siSsn">Last 4 of SSN</label>
      <input id="siSsn" type="password" inputmode="numeric" maxlength="4" pattern="\d{4}" autocomplete="off">
    </div>
    <button id="signinBtn" type="button">Sign In</button>
  </section>

  <!-- Portal screen -->
  <section id="portalView" class="card hidden">
    <h1>Hello, <span id="empName"></span></h1>
    <div class="balance"><span id="empBalance">5</span> day<span id="dayPlural">s</span> remaining</div>
    <div class="balance-sub">5 PTO days per calendar year</div>

    <h2>Request time off</h2>
    <div id="reqErr" class="err"></div>
    <div class="row">
      <div class="field">
        <label for="reqStart">Start date</label>
        <input id="reqStart" type="date">
      </div>
      <div class="field">
        <label for="reqEnd">End date</label>
        <input id="reqEnd" type="date">
      </div>
    </div>
    <div class="balance-sub" id="dayPreview"></div>
    <div class="field" style="margin-top:12px;">
      <label for="reqReason">Reason</label>
      <textarea id="reqReason" maxlength="500" placeholder="Vacation, medical appointment, etc."></textarea>
    </div>
    <button id="submitBtn" type="button">Submit Request</button>

    <h2>Your requests</h2>
    <ul id="reqList" class="req"></ul>
  </section>

</main>
<script type="module">
  const $ = (id) => document.getElementById(id);
  let creds = null; // { name, ssn4 }

  function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }
  function hideErr(el) { el.style.display = 'none'; }

  async function api(body) {
    const res = await fetch('/api/pto-public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderHistory(history) {
    const ul = $('reqList');
    if (!history.length) { ul.innerHTML = '<li style="color:var(--text-muted);">No requests yet.</li>'; return; }
    ul.innerHTML = history.map(r => {
      const cls = 'status-' + r.status;
      const label = r.status[0].toUpperCase() + r.status.slice(1);
      const note = r.status === 'denied' && r.decisionNote
        ? `<div class="note">Note: ${escapeHtml(r.decisionNote)}</div>` : '';
      return `<li>
        <span class="${cls}">${label}</span> ·
        ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)} (${r.days} d) ·
        <span style="color:var(--text-muted);">${escapeHtml(r.reason)}</span>
        ${note}
      </li>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function showPortal(emp, history) {
    $('signinView').classList.add('hidden');
    $('portalView').classList.remove('hidden');
    $('empName').textContent = emp.name;
    $('empBalance').textContent = emp.balanceDays;
    $('dayPlural').textContent = emp.balanceDays === 1 ? '' : 's';
    renderHistory(history);
  }

  function updateDayPreview() {
    const s = $('reqStart').value, e = $('reqEnd').value;
    if (!s || !e) { $('dayPreview').textContent = ''; return; }
    const start = new Date(s + 'T00:00:00Z'), end = new Date(e + 'T00:00:00Z');
    if (end < start) { $('dayPreview').textContent = 'End date is before start date.'; return; }
    let days = 0;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) days++;
    }
    $('dayPreview').textContent = `${days} weekday${days === 1 ? '' : 's'}`;
  }
  $('reqStart').addEventListener('change', updateDayPreview);
  $('reqEnd').addEventListener('change', updateDayPreview);

  $('signinBtn').addEventListener('click', async () => {
    hideErr($('signinErr'));
    const name = $('siName').value.trim();
    const ssn4 = $('siSsn').value.trim();
    if (!name || !/^\d{4}$/.test(ssn4)) {
      showErr($('signinErr'), 'Enter your full name and last 4 of SSN.');
      return;
    }
    $('signinBtn').disabled = true;
    const { status, data } = await api({ action: 'login', name, ssn4 });
    $('signinBtn').disabled = false;
    if (!data.ok) { showErr($('signinErr'), data.error || 'Sign-in failed.'); return; }
    creds = { name, ssn4 };
    showPortal(data.employee, data.history || []);
  });

  $('submitBtn').addEventListener('click', async () => {
    hideErr($('reqErr'));
    const startDate = $('reqStart').value, endDate = $('reqEnd').value;
    const reason = $('reqReason').value.trim();
    if (!startDate || !endDate) { showErr($('reqErr'), 'Pick a start and end date.'); return; }
    if (!reason) { showErr($('reqErr'), 'Please add a reason.'); return; }
    $('submitBtn').disabled = true;
    const { status, data } = await api({
      action: 'request', name: creds.name, ssn4: creds.ssn4,
      startDate, endDate, reason,
    });
    if (!data.ok) {
      showErr($('reqErr'), data.error || 'Request failed.');
      $('submitBtn').disabled = false;
      return;
    }
    // Refresh portal from the server so balance + history reflect the new pending request.
    const refresh = await api({ action: 'login', name: creds.name, ssn4: creds.ssn4 });
    if (refresh.data.ok) {
      $('empBalance').textContent = refresh.data.employee.balanceDays;
      renderHistory(refresh.data.history || []);
    }
    $('reqStart').value = ''; $('reqEnd').value = ''; $('reqReason').value = '';
    $('dayPreview').textContent = '';
    $('submitBtn').disabled = false;
    alert('Request submitted. You will receive an email once the owner decides.');
  });
</script>
</body>
</html>
```

- [ ] **Step 2: Sanity check**

Run: `node -e "const h=require('fs').readFileSync('pto.html','utf8'); if(!h.includes('signinView')||!h.includes('portalView')) throw new Error('missing views'); console.log('pto.html OK');"`
Expected: prints `pto.html OK`.

- [ ] **Step 3: Commit**

```bash
git add pto.html
git commit -m "feat(pto): employee portal page"
```

---

## Task 13: `pto-admin.html` — admin page

**Files:**
- Create: `pto-admin.html`

- [ ] **Step 1: Write the page**

Create `pto-admin.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PTO Admin — Montissol Essentials</title>
  <meta name="robots" content="noindex">
  <style>
    :root{
      --bg:#0a0a0a; --card:#141414; --text:#f1f1f1; --text-muted:#888;
      --border:#2a2a2a; --brand:#e74d10; --radius:10px;
    }
    *{box-sizing:border-box;}
    body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",sans-serif;line-height:1.5;}
    main{max-width:960px;margin:32px auto;padding:24px;}
    h1{margin:0 0 16px 0;}
    h2{margin:24px 0 12px 0;font-size:1.15rem;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;}
    label{display:block;font-size:.85rem;color:var(--text-muted);margin-bottom:6px;}
    input,textarea,select{width:100%;padding:9px 12px;background:#0a0a0a;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:.92rem;}
    button{padding:9px 16px;background:var(--brand);color:#fff;border:none;border-radius:8px;font-size:.9rem;font-weight:600;cursor:pointer;}
    button.ghost{background:transparent;border:1px solid var(--border);color:var(--text);}
    button.green{background:#16a34a;}
    button.red{background:#dc2626;}
    button:disabled{opacity:.5;cursor:not-allowed;}
    .row{display:grid;grid-template-columns:repeat(3, 1fr);gap:10px;margin-bottom:10px;}
    .err{color:#f87171;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:10px 14px;margin-bottom:12px;display:none;}
    table{width:100%;border-collapse:collapse;}
    th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);font-size:.9rem;}
    th{color:var(--text-muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;}
    .muted{color:var(--text-muted);}
    .hidden{display:none;}
    .actions{display:flex;gap:6px;flex-wrap:wrap;}
  </style>
</head>
<body>
<main>

  <!-- Login -->
  <section id="loginView" class="card">
    <h1>PTO Admin</h1>
    <div id="loginErr" class="err"></div>
    <div style="margin-bottom:12px;">
      <label for="pwd">Admin password</label>
      <input id="pwd" type="password" autocomplete="current-password">
    </div>
    <button id="loginBtn" type="button">Sign In</button>
  </section>

  <!-- App -->
  <section id="appView" class="hidden">
    <h1>PTO Admin</h1>

    <div class="card">
      <h2>Pending requests (<span id="pendingCount">0</span>)</h2>
      <div id="pendingList"></div>
    </div>

    <div class="card">
      <h2>Employees (<span id="empCount">0</span>) <button id="showAddBtn" class="ghost" style="float:right;">+ Add Employee</button></h2>
      <div id="addEmpForm" class="hidden" style="margin-bottom:16px;padding:14px;border:1px solid var(--border);border-radius:8px;">
        <div class="row">
          <div><label>Full name</label><input id="addName"></div>
          <div><label>Email</label><input id="addEmail" type="email"></div>
          <div><label>Last 4 SSN</label><input id="addSsn" maxlength="4" pattern="\d{4}" inputmode="numeric"></div>
        </div>
        <div id="addErr" class="err"></div>
        <button id="addEmpBtn">Add Employee</button>
        <button id="cancelAddBtn" class="ghost">Cancel</button>
      </div>
      <table id="empTable"><thead>
        <tr><th>Name</th><th>Email</th><th>Balance</th><th></th></tr>
      </thead><tbody id="empBody"></tbody></table>
    </div>

    <div class="card">
      <h2>Decided (last 50)</h2>
      <div id="decidedList"></div>
    </div>
  </section>

</main>
<script type="module">
  const $ = (id) => document.getElementById(id);
  let password = null;

  function escape(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  }

  async function api(path, opts = {}) {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + password };
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  $('loginBtn').addEventListener('click', async () => {
    const pwd = $('pwd').value;
    if (!pwd) return;
    password = pwd;
    const { status } = await api('/api/pto?resource=employees', { method: 'GET' });
    if (status === 401) {
      password = null;
      $('loginErr').textContent = 'Wrong password.';
      $('loginErr').style.display = 'block';
      return;
    }
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    await reloadAll();
  });

  async function reloadAll() {
    await Promise.all([reloadEmployees(), reloadRequests()]);
  }

  async function reloadEmployees() {
    const { data } = await api('/api/pto?resource=employees', { method: 'GET' });
    const employees = data.employees || [];
    $('empCount').textContent = employees.length;
    $('empBody').innerHTML = employees.map(e => `
      <tr data-id="${e.id}">
        <td>${escape(e.name)}</td>
        <td>${escape(e.email)}</td>
        <td>${e.balanceDays} d</td>
        <td class="actions">
          <button class="ghost" data-act="adjust">Adjust</button>
          <button class="ghost" data-act="ssn">Reset SSN</button>
          <button class="ghost" data-act="del">🗑</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="muted">No employees yet.</td></tr>';
    $('empBody').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => handleEmpAction(btn));
    });
  }

  async function handleEmpAction(btn) {
    const id = btn.closest('tr').dataset.id;
    const act = btn.dataset.act;
    if (act === 'del') {
      if (!confirm('Delete this employee? Their request history is preserved.')) return;
      await api('/api/pto?resource=employees&id=' + encodeURIComponent(id), { method: 'DELETE' });
      reloadEmployees();
    } else if (act === 'adjust') {
      const v = prompt('Set new PTO balance (days):');
      if (v === null) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return alert('Must be a non-negative number.');
      await api('/api/pto?resource=employees&id=' + encodeURIComponent(id), { method: 'PATCH', body: { balanceDays: n } });
      reloadEmployees();
    } else if (act === 'ssn') {
      const v = prompt('New last 4 of SSN:');
      if (v === null) return;
      if (!/^\d{4}$/.test(v)) return alert('Must be exactly 4 digits.');
      await api('/api/pto?resource=employees&id=' + encodeURIComponent(id), { method: 'PATCH', body: { ssn4: v } });
      alert('SSN updated.');
    }
  }

  async function reloadRequests() {
    const { data: pendingRes } = await api('/api/pto?resource=requests&status=pending', { method: 'GET' });
    const pending = pendingRes.requests || [];
    $('pendingCount').textContent = pending.length;
    $('pendingList').innerHTML = pending.map(r => `
      <div style="padding:12px 0;border-bottom:1px solid var(--border);">
        <div><strong>${escape(r.employeeName)}</strong> · ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)} (${r.days} d)</div>
        <div class="muted">${escape(r.reason)}</div>
        <div class="actions" style="margin-top:8px;">
          <button class="green" data-req="${r.id}" data-act="approve">✅ Approve</button>
          <button class="red" data-req="${r.id}" data-act="deny">❌ Deny</button>
        </div>
      </div>
    `).join('') || '<div class="muted">No pending requests.</div>';
    $('pendingList').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => handleDecide(btn));
    });

    const { data: allRes } = await api('/api/pto?resource=requests', { method: 'GET' });
    const decided = (allRes.requests || []).filter(r => r.status !== 'pending');
    $('decidedList').innerHTML = decided.map(r => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:.9rem;">
        <strong>${escape(r.employeeName)}</strong> · ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)} (${r.days} d) ·
        <span style="color:${r.status === 'approved' ? '#22c55e' : '#f87171'};">${r.status}</span>
        ${r.decisionNote ? ` · <span class="muted">"${escape(r.decisionNote)}"</span>` : ''}
      </div>
    `).join('') || '<div class="muted">No decided requests.</div>';
  }

  async function handleDecide(btn) {
    const id = btn.dataset.req;
    const decision = btn.dataset.act;
    let note = null;
    if (decision === 'deny') {
      note = prompt('Optional reason (visible to the employee):') || null;
    }
    btn.disabled = true;
    const { status, data } = await api('/api/pto?resource=decide&id=' + encodeURIComponent(id), { method: 'POST', body: { decision, note } });
    if (!data.ok) alert('Failed: ' + (data.error || status));
    reloadAll();
  }

  $('showAddBtn').addEventListener('click', () => { $('addEmpForm').classList.toggle('hidden'); });
  $('cancelAddBtn').addEventListener('click', () => { $('addEmpForm').classList.add('hidden'); });

  $('addEmpBtn').addEventListener('click', async () => {
    $('addErr').style.display = 'none';
    const name = $('addName').value.trim();
    const email = $('addEmail').value.trim();
    const ssn4 = $('addSsn').value.trim();
    if (!name || !email || !/^\d{4}$/.test(ssn4)) {
      $('addErr').textContent = 'Name, email, and 4-digit SSN are required.';
      $('addErr').style.display = 'block';
      return;
    }
    const { data } = await api('/api/pto?resource=employees', { method: 'POST', body: { name, email, ssn4 } });
    if (!data.ok) {
      $('addErr').textContent = data.error || 'Failed to add.';
      $('addErr').style.display = 'block';
      return;
    }
    $('addName').value = ''; $('addEmail').value = ''; $('addSsn').value = '';
    $('addEmpForm').classList.add('hidden');
    reloadEmployees();
  });
</script>
</body>
</html>
```

- [ ] **Step 2: Sanity check**

Run: `node -e "const h=require('fs').readFileSync('pto-admin.html','utf8'); if(!h.includes('loginView')||!h.includes('appView')) throw new Error('missing views'); console.log('pto-admin.html OK');"`
Expected: prints `pto-admin.html OK`.

- [ ] **Step 3: Commit**

```bash
git add pto-admin.html
git commit -m "feat(pto): admin page"
```

---

## Task 14: Deploy and manual end-to-end test

**Files:** none (verification step). **Requires the user** — set env var, deploy, then run through the flow.

- [ ] **Step 1: Set the env var in Vercel**

Generate a fresh secret locally:
```bash
openssl rand -base64 32
```
Add it to Vercel: Dashboard → project → Settings → Environment Variables → add `PTO_APPROVAL_SECRET` (Production) with the generated value.

- [ ] **Step 2: Merge to main and push**

The Vercel GitHub integration deploys on push.

```bash
git checkout main && git merge feat/pto-system --ff-only && git push origin main
```

Wait ~90 seconds for the build to go live. Verify:
```bash
curl -s "https://montissolessentials.com/pto.html" | grep -q signinView && echo "pto.html live"
curl -s "https://montissolessentials.com/pto-admin.html" | grep -q loginView && echo "pto-admin.html live"
curl -s -o /dev/null -w "%{http_code}\n" "https://montissolessentials.com/api/pto-public"
```
Expected: both `live` lines print; `/api/pto-public` returns `405` (POST-only).

- [ ] **Step 3: Add a test employee**

Open https://montissolessentials.com/pto-admin.html. Log in with the existing admin password. Click **+ Add Employee** → use your own name, your own email, last-4 SSN `0000`. Confirm the employee appears with balance 5.

- [ ] **Step 4: Submit a request as the test employee**

Open https://montissolessentials.com/pto.html in a separate browser (or incognito). Sign in with the test-employee name and `0000`. Confirm the portal loads showing balance 5. Submit a 1-day request for next Tuesday with reason "manual test".

- [ ] **Step 5: Verify the owner alert email arrives**

Check the inbox at `OWNER_EMAIL`. Email subject: `PTO request: <Your Name> — <date> to <date> (1 d)`. Contains Approve and Deny buttons.

- [ ] **Step 6: Test email approve**

Click **Approve** in the email. Browser shows "Approved ✓". Refresh the employee portal — balance should now be 4. Test employee receives a "PTO approved" email.

- [ ] **Step 7: Test admin-portal deny**

Submit a second test request from the employee portal. In the admin portal, click **Deny** on it, add an optional note like "test deny". Confirm: request moves to Decided, balance stays at 4, test employee receives the "PTO not approved" email with the note.

- [ ] **Step 8: Test the one-time-use guarantee**

Submit a third request. In the alert email, click Approve. Then click Deny from the same email — should show "Already decided or expired" (410).

- [ ] **Step 9: Clean up**

In the admin portal, delete the test employee. Confirm decided requests still appear in the Decided section (employeeName preserved).

---

## Self-Review Checklist (run after writing this plan)

- [x] **Spec coverage** — every spec section maps to a task:
  - SSN-4 bcrypt hash & verify → Task 5
  - `findEmployee` name+ssn4 lookup → Task 5
  - Weekday counter → Task 3
  - HMAC magic-link tokens → Task 4
  - Sliding-window rate limit → Task 6
  - Employee + request store with lazy balance reset → Task 7
  - One-time-use decision claim key → Task 7 (`createRequest` writes it, `decideRequest` consumes it)
  - Email templates + Resend → Task 8
  - Public endpoint (login + submit) → Task 9
  - Admin endpoint (CRUD + decide) → Task 10
  - Magic-link decision endpoint → Task 11
  - Employee portal page → Task 12
  - Admin page → Task 13
  - Manual end-to-end test → Task 14
- [x] **No placeholders** — every code step has full code; no TBD/TODO
- [x] **Type consistency** — `redis` exports identical across helpers; `KEYS` builders consistent; `findEmployee(name, ssn4, employees)` signature matches both unit tests and the public-endpoint call; `decideRequest(redis, requestId, decision, note)` signature matches admin endpoint, decision endpoint, and tests
- [x] **Frequent commits** — every task ends with at least one commit
