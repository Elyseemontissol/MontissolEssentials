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

export function renderApprovedCancelledEmail({ request, employeeName }) {
  const newBalance = Number(request.newBalance);
  const balanceLine = Number.isFinite(newBalance)
    ? `<p>Their PTO balance has been restored to <strong>${newBalance} day${newBalance === 1 ? '' : 's'}</strong>. No further action needed.</p>`
    : `<p>Their PTO balance has been restored. No further action needed.</p>`;
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;">
      <h2 style="color:#dc2626;margin:0 0 12px 0;">PTO cancelled</h2>
      <p><strong>${escapeHtml(employeeName)}</strong> cancelled their previously-approved time off:</p>
      <p style="background:#fef3c7;padding:12px;border-radius:6px;">
        <strong>${escapeHtml(request.startDate)} – ${escapeHtml(request.endDate)}</strong> (${request.days} day${request.days === 1 ? '' : 's'})
      </p>
      ${balanceLine}
      <p style="color:#666;margin-top:24px;">— Montissol Essentials PTO</p>
    </div>
  `;
}

export async function sendOwnerAlert({ apiKey, to, subject, html }) {
  const resend = new Resend(apiKey);
  return resend.emails.send({
    from: 'Paid Time Off Request <noreply@montissolessentials.com>',
    to, subject, html,
  });
}

export async function sendEmployeeDecision({ apiKey, to, subject, html }) {
  const resend = new Resend(apiKey);
  return resend.emails.send({
    from: 'Paid Time Off Request <noreply@montissolessentials.com>',
    to, subject, html,
  });
}
