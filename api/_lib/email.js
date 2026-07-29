import { Resend } from 'resend';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderApprovalEmail({ theme, weekDate, caption, hashtags, imageUrl, approveUrl, editUrl, rejectUrl, draftId, dryRun }) {
  const banner = dryRun
    ? `<div style="background:#fef3c7;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600;">TEST - would post to Instagram and Facebook. No real publish.</div>`
    : '';
  const imageBlock = imageUrl
    ? `<img src="${imageUrl}" alt="" style="max-width:100%;border-radius:8px;margin:12px 0;"/>`
    : `<div style="padding:12px;border:1px dashed #ccc;border-radius:8px;color:#666;margin:12px 0;">No image (generation failed) — post will be text-only.</div>`;
  const tags = hashtags.length
    ? `<p style="color:#1d4ed8;">${escapeHtml(hashtags.join(' '))}</p>`
    : '';
  const btn = (href, label, bg) =>
    `<a href="${href}" style="display:inline-block;padding:10px 18px;background:${bg};color:#fff;border-radius:6px;text-decoration:none;margin-right:8px;">${label}</a>`;
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;margin:auto;padding:24px;">
      ${banner}
      <h2 style="margin:0 0 8px 0;">Social draft - theme: ${escapeHtml(theme)}</h2>
      <p style="color:#666;margin:0 0 8px 0;">Week of ${escapeHtml(weekDate)} - Draft ID ${escapeHtml(draftId)}</p>
      ${imageBlock}
      <div style="white-space:pre-wrap;line-height:1.5;">${escapeHtml(caption)}</div>
      ${tags}
      <div style="margin-top:24px;">
        ${btn(approveUrl, '✅ Approve & post', '#16a34a')}
        ${btn(editUrl, '✏️ Edit', '#2563eb')}
        ${btn(rejectUrl, '❌ Reject', '#dc2626')}
      </div>
      <p style="color:#999;font-size:12px;margin-top:24px;">Expires in 72 hours. One-time-use links.</p>
    </div>
  `;
}

export async function sendApprovalEmail({ apiKey, to, subject, html }) {
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: 'Montissol FB Agent <noreply@montissolessentials.com>',
    to,
    subject,
    html,
  });
  if (result.error) {
    throw new Error(`Resend email error: ${result.error.message || JSON.stringify(result.error)}`);
  }
  return result.data;
}
