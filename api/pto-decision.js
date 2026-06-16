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
