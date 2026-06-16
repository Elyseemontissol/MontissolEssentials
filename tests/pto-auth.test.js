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
