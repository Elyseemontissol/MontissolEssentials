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
