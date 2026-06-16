import crypto from 'node:crypto';
import { redis, KEYS } from './_lib/pto-redis.js';
import {
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  adjustBalance, listRequests, getRequest, decideRequest, getEmployee,
  listEmployeeRequests, createRequest,
} from './_lib/pto-store.js';
import { findEmployee } from './_lib/pto-auth.js';
import { renderOwnerAlertEmail, renderEmployeeDecisionEmail, sendOwnerAlert, sendEmployeeDecision } from './_lib/pto-email.js';
import { signToken, verifyToken } from './_lib/pto-tokens.js';
import { checkAndRecordAttempt, clearAttempts } from './_lib/pto-rate-limit.js';
import { normalizeName } from './_lib/pto-redis.js';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SEC = 900;
const IP_MAX_ATTEMPTS = 30;
const GENERIC_AUTH_ERROR = 'Sign-in failed. Check your name and last 4 of SSN.';

function appBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://montissolessentials.com';
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

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

// ── Decision flow (email magic-link) — GET /api/pto?token=... ──
function decisionHtmlPage(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:48px auto;padding:24px;color:#111;}
      .ok{color:#16a34a;} .err{color:#dc2626;}</style>
      </head><body>${body}</body></html>`,
  };
}

function sendHtml(res, page) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(page.status).send(page.html);
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function handleDecisionMagicLink(req, res) {
  const token = req.query?.token;
  const payload = verifyToken(token, process.env.PTO_APPROVAL_SECRET);
  if (!payload) return sendHtml(res, decisionHtmlPage('Invalid token', '<h1 class="err">Invalid or forged token</h1>', 401));

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
    return sendHtml(res, decisionHtmlPage(label,
      `<h1 class="${decision === 'approve' ? 'ok' : 'err'}">${label}</h1>
       <p>Request for <strong>${escape(updated.employeeName)}</strong>, ${escape(updated.startDate)} – ${escape(updated.endDate)} (${updated.days} d).</p>
       <p>The employee has been emailed.</p>`));
  } catch (err) {
    const msg = err.message || 'Decide failed';
    if (/already decided/i.test(msg)) {
      return sendHtml(res, decisionHtmlPage('Already decided',
        '<h1 class="err">Already decided or expired</h1><p>This link can only be used once.</p>', 410));
    }
    if (/not found/i.test(msg)) {
      return sendHtml(res, decisionHtmlPage('Not found', '<h1 class="err">Request not found</h1>', 404));
    }
    return sendHtml(res, decisionHtmlPage('Error',
      `<h1 class="err">Decision failed</h1><pre>${escape(msg)}</pre>`, 500));
  }
}

// ── Public flow — POST {action: 'login' | 'request', name, ssn4, ...} ──
function actionUrls(requestId, secret) {
  const base = appBaseUrl();
  return {
    approveUrl: `${base}/api/pto?token=${signToken(requestId, 'approve', secret)}`,
    denyUrl:    `${base}/api/pto?token=${signToken(requestId, 'deny', secret)}`,
  };
}

async function handlePublic(req, res) {
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

// ── Admin flow — bearer auth required ──
async function handleAdmin(req, res) {
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

// ── Dispatcher ──
export default async function handler(req, res) {
  // 1. Decision magic-link: GET with ?token=
  if (req.method === 'GET' && req.query?.token) {
    return handleDecisionMagicLink(req, res);
  }

  // 2. Admin flow: any request carrying a Bearer token
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    if (!(await checkAuth(req))) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return handleAdmin(req, res);
  }

  // 3. Public flow: POST {action, name, ssn4, ...}
  if (req.method === 'POST') {
    return handlePublic(req, res);
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
