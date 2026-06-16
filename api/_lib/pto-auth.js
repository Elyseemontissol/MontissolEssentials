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
