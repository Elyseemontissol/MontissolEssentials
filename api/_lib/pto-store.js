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

// Normalize legacy records that pre-date the `project` field.
function withProjectDefault(emp) {
  if (!emp) return emp;
  if (emp.project === undefined || emp.project === null || emp.project === '') {
    return { ...emp, project: 'Unassigned' };
  }
  return emp;
}

export async function getEmployee(redis, id, currentYear) {
  const raw = await redis.get(KEYS.employee(id));
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const emp = withProjectDefault(parsed);
  const after = maybeReset(emp, currentYear);
  if (after.lastResetYear !== emp.lastResetYear || after.project !== parsed.project) {
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

export async function createEmployee(redis, { name, email, ssn4, project }, currentYear) {
  if (!name || !email) throw new Error('Name and email are required.');
  const id = randomUUID();
  const emp = {
    id,
    name: String(name).trim(),
    nameKey: normalizeName(name),
    email: String(email).trim(),
    project: String(project || '').trim() || 'Unassigned',
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
  if (updates.project !== undefined) {
    next.project = String(updates.project).trim() || 'Unassigned';
  }
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

// Detect approved PTO overlaps on the same project. Returns the first matching
// date range (without identifying the other employee) or null if clear.
// `excludeEmployeeId` lets a user not conflict with themselves. `excludeRequestId`
// lets an edit not conflict with its own prior approved range.
export async function findProjectConflict(redis, { project, startDate, endDate, excludeEmployeeId, excludeRequestId }) {
  if (!project || project === 'Unassigned') return null;
  const ids = await redis.lrange(KEYS.requests, 0, GLOBAL_REQUEST_CAP - 1);
  const year = new Date().getUTCFullYear();
  for (const id of ids) {
    const r = await getRequest(redis, id);
    if (!r) continue;
    if (r.status !== 'approved') continue;
    if (excludeRequestId && r.id === excludeRequestId) continue;
    if (excludeEmployeeId && r.employeeId === excludeEmployeeId) continue;
    // Overlap: startA <= endB && endA >= startB (string ISO dates compare chronologically)
    if (r.startDate > endDate) continue;
    if (r.endDate < startDate) continue;
    const otherEmp = await getEmployee(redis, r.employeeId, year);
    if (!otherEmp) continue;
    if (otherEmp.project !== project) continue;
    return { startDate: r.startDate, endDate: r.endDate };
  }
  return null;
}

export async function createRequest(redis, { employee, startDate, endDate, reason }) {
  const days = countWeekdays(startDate, endDate);
  if (days <= 0) throw new Error('Request must include at least one weekday.');
  if (days > employee.balanceDays) {
    throw new Error(`Requested ${days} day(s) exceed your remaining balance of ${employee.balanceDays}.`);
  }
  if (!reason || !String(reason).trim()) throw new Error('Reason is required.');

  // Block if a teammate on the same project already has approved PTO that overlaps.
  // The message is deliberately non-identifying — no name or email of the teammate.
  const conflict = await findProjectConflict(redis, {
    project: employee.project,
    startDate,
    endDate,
    excludeEmployeeId: employee.id,
  });
  if (conflict) {
    throw new Error(
      `Another teammate on your project already has approved time off from ${conflict.startDate} to ${conflict.endDate}. Please choose different dates or contact HR.`
    );
  }

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

export async function cancelRequest(redis, requestId, employeeId) {
  const req = await getRequest(redis, requestId);
  if (!req) throw new Error('Request not found.');
  if (req.employeeId !== employeeId) throw new Error('Not your request.');
  if (req.status !== 'pending' && req.status !== 'approved') {
    throw new Error('Only pending or approved requests can be cancelled.');
  }
  const wasApproved = req.status === 'approved';
  req.previousStatus = req.status;
  req.status = 'cancelled';
  req.cancelledAt = new Date().toISOString();
  await redis.set(KEYS.request(requestId), JSON.stringify(req));
  // Invalidate the owner's approve/deny magic-links so the email becomes inert.
  await redis.del(KEYS.decisionClaim(requestId));
  if (wasApproved) {
    // Restore the days that were deducted at approval time.
    const year = new Date().getUTCFullYear();
    const emp = await getEmployee(redis, employeeId, year);
    if (emp) {
      await adjustBalance(redis, employeeId, emp.balanceDays + req.days, 'set');
    }
  }
  return req;
}

export async function editRequest(redis, { requestId, employee, startDate, endDate, reason }) {
  const req = await getRequest(redis, requestId);
  if (!req) throw new Error('Request not found.');
  if (req.employeeId !== employee.id) throw new Error('Not your request.');
  if (req.status !== 'pending' && req.status !== 'approved') {
    throw new Error('Only pending or approved requests can be edited.');
  }
  const days = countWeekdays(startDate, endDate);
  if (days <= 0) throw new Error('Request must include at least one weekday.');
  if (!reason || !String(reason).trim()) throw new Error('Reason is required.');

  const wasApproved = req.status === 'approved';
  const oldDays = req.days;
  // Effective balance: for an approved edit, the old days were already deducted —
  // they become "available" once we revert the request to pending.
  const effectiveBalance = wasApproved ? employee.balanceDays + oldDays : employee.balanceDays;
  if (days > effectiveBalance) {
    throw new Error(`Requested ${days} day(s) exceed your remaining balance of ${effectiveBalance}.`);
  }

  // Same project-conflict check as createRequest, excluding the request being edited.
  const conflict = await findProjectConflict(redis, {
    project: employee.project,
    startDate,
    endDate,
    excludeEmployeeId: employee.id,
    excludeRequestId: requestId,
  });
  if (conflict) {
    throw new Error(
      `Another teammate on your project already has approved time off from ${conflict.startDate} to ${conflict.endDate}. Please choose different dates or contact HR.`
    );
  }

  req.startDate = startDate;
  req.endDate = endDate;
  req.days = days;
  req.reason = String(reason).trim().slice(0, 500);
  req.editedAt = new Date().toISOString();

  if (wasApproved) {
    // Revert to pending — the owner's original approval was for different details.
    req.status = 'pending';
    req.previousStatus = 'approved';
    req.decidedAt = null;
    req.decisionNote = null;
    // Restore the originally-deducted days; the owner re-deducts on re-approve.
    const year = new Date().getUTCFullYear();
    const emp = await getEmployee(redis, employee.id, year);
    if (emp) {
      await adjustBalance(redis, employee.id, emp.balanceDays + oldDays, 'set');
    }
    // Recreate the decision-claim key so the fresh owner alert email's
    // Approve/Deny magic-links work.
    await redis.set(KEYS.decisionClaim(requestId), 'unused', { ex: REQUEST_TTL_SECONDS });
  }

  await redis.set(KEYS.request(requestId), JSON.stringify(req));
  return req;
}

export async function decideRequest(redis, requestId, decision, note, options = {}) {
  if (decision !== 'approve' && decision !== 'deny') {
    throw new Error('decision must be "approve" or "deny"');
  }
  const adminBypass = !!options.admin;

  if (adminBypass) {
    // Admin path: the auth'd admin page can decide at any point while the
    // request is still pending, regardless of the one-shot magic-link claim's
    // state (the claim has a 72h TTL and auto-expires, leaving pending
    // requests stuck otherwise). We still clear the claim so the emailed
    // magic-links can't double-decide after the fact.
    const req = await getRequest(redis, requestId);
    if (!req) throw new Error('Request not found.');
    if (req.status !== 'pending') throw new Error('Already decided.');
    await redis.del(KEYS.decisionClaim(requestId));
    req.status = decision === 'approve' ? 'approved' : 'denied';
    req.decidedAt = new Date().toISOString();
    req.decisionNote = note ? String(note).slice(0, 500) : null;
    await redis.set(KEYS.request(requestId), JSON.stringify(req));
    if (decision === 'approve') {
      await adjustBalance(redis, req.employeeId, req.days, 'used');
    }
    return req;
  }

  // Email magic-link path: one-shot claim prevents replay from a forwarded email.
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
