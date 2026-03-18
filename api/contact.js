import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { name, email, phone, companyName, subject, message, company } = req.body || {};

  // Honeypot spam trap - if filled, silently accept
  if (company) {
    return res.status(200).json({ ok: true });
  }

  // Validate required fields
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    await resend.emails.send({
      from: 'Montissol Website <onboarding@resend.dev>',
      to: 'ElyseeM@MontissolEssentials.com',
      replyTo: email,
      subject: `[Website] ${subject} - ${name}`,
      html: `
        <h2>New Contact Form Submission</h2>
        <table style="border-collapse:collapse; width:100%; max-width:600px; font-family:Arial,sans-serif;">
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555; width:160px;">Name</td>
            <td style="padding:12px;">${esc(name)}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555;">Email</td>
            <td style="padding:12px;"><a href="mailto:${esc(email)}">${esc(email)}</a></td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555;">Phone</td>
            <td style="padding:12px;">${esc(phone || 'N/A')}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555;">Company</td>
            <td style="padding:12px;">${esc(companyName || 'N/A')}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555;">Service</td>
            <td style="padding:12px;">${esc(subject)}</td>
          </tr>
          <tr>
            <td style="padding:12px; font-weight:bold; color:#555; vertical-align:top;">Message</td>
            <td style="padding:12px; white-space:pre-wrap;">${esc(message)}</td>
          </tr>
        </table>
        <hr style="margin:24px 0; border:none; border-top:1px solid #eee;">
        <p style="color:#999; font-size:12px;">Sent from the Montissol Essentials website contact form.</p>
      `,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Resend error:', error);
    return res.status(500).json({ ok: false, error: 'Failed to send message' });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
