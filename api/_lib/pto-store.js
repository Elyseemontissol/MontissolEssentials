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
