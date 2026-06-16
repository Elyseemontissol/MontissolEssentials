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
