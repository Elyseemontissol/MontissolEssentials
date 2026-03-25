import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { email, company } = req.body || {};

  // Honeypot spam trap - if filled, silently accept
  if (company) {
    return res.status(200).json({ ok: true });
  }

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
  }

  try {
    await resend.emails.send({
      from: 'Montissol Website <noreply@montissolessentials.com>',
      to: 'ElyseeM@MontissolEssentials.com',
      subject: `[Website] New Newsletter Subscriber`,
      html: `
        <h2>New Newsletter Subscriber</h2>
        <table style="border-collapse:collapse; width:100%; max-width:600px; font-family:Arial,sans-serif;">
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:12px; font-weight:bold; color:#555; width:160px;">Email</td>
            <td style="padding:12px;"><a href="mailto:${esc(email)}">${esc(email)}</a></td>
          </tr>
        </table>
        <hr style="margin:24px 0; border:none; border-top:1px solid #eee;">
        <p style="color:#999; font-size:12px;">Sent from the Montissol Essentials website newsletter form.</p>
      `,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Resend error:', error);
    const msg = error?.message || error?.statusCode || JSON.stringify(error);
    return res.status(500).json({ ok: false, error: 'Resend: ' + msg });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
