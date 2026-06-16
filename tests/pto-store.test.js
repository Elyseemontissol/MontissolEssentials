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
  const { adjustBalance } = await import('../api/_lib/pto-store.js');
  await adjustBalance(mock, emp.id, 4, 'used');
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
