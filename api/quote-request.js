import { Resend } from 'resend';
import PDFDocument from 'pdfkit';

const resend = new Resend(process.env.RESEND_API_KEY);

// Aviation vendor pre-qualification questionnaire lives on
// /aviation-vendor-questionnaire.html and POSTs here with
// ?type=vendor-questionnaire. Fully separate flow from the quote-request
// form above — generates a PDF and emails it to the owner.
const VENDOR_QUESTIONS = [
  { key: 'q3_unPreQualified',      label: 'Pre-qualified Air Operator with the UN Secretariat?' },
  { key: 'q5_aircraftDetails',     label: 'Aircraft details (comparable to A330 / 767 / 787 / 737 / A320 / C-130 / L-382 / other)' },
  { key: 'q6_ownership',           label: 'Aircraft owned, leased, or subcontracted' },
  { key: 'q11_fleetList',          label: 'List of aircraft available (with count for next 18 months)' },
  { key: 'q12_paxCapacity',        label: 'Passenger capacity per aircraft (100 kg luggage entitlement)' },
  { key: 'q7_aoc',                 label: 'AOC number and issuing Civil Aviation Authority' },
  { key: 'q8_dangerousGoods',      label: 'AOC endorsed for Dangerous Goods?' },
  { key: 'q8_dangerousGoodsNote',  label: 'Dangerous Goods — details / timeline (if Other)' },
  { key: 'q9_icao',                label: 'ICAO safety concerns confirmation' },
  { key: 'q9_icaoNote',            label: 'ICAO — details (if concerns or Other)' },
  { key: 'q13_insurance',          label: 'Comply with UN insurance requirements?' },
  { key: 'q13_insuranceNote',      label: 'Insurance — explanation (if No or Other)' },
  { key: 'q10_mob',                label: 'Main Operating Base (MOB) location' },
  { key: 'q14_pap',                label: 'Authorized and willing to operate into Port-au-Prince (PAP)?' },
  { key: 'q15_papApprovals',       label: 'PAP — approvals or conditions required (if not currently operating)' },
  { key: 'q16_papRecent',          label: 'Operated into PAP within the last 24 months?' },
  { key: 'q16_papRecentDetails',   label: 'PAP recent operations — details' },
  { key: 'q17_routes',             label: 'Supported operations' },
  { key: 'q21_caaExemption',       label: 'CAA exemption / clearance for PAP (if currently prohibited)' },
  { key: 'q18_responseTime',       label: 'Typical response time to mobilize aircraft after contract award' },
  { key: 'q18_responseTimeOther',  label: 'Response time — specify (if Other)' },
  { key: 'q19_unRequirements',     label: 'What the UN would need to provide for commitment / availability' },
  { key: 'q20_flightHourCost',     label: 'Flight Hour Cost (excludes fuel)' },
  { key: 'q22_additional',         label: 'Additional information' },
];

function fmtAnswer(v) {
  if (v === undefined || v === null || v === '') return 'Not answered';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'None selected';
  return String(v);
}

function buildVendorPdf({ companyName, contactName, contactEmail, contactPhone, submittedAt, answers }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0a0a0a')
         .text('Aviation Vendor Pre-Qualification Questionnaire', { align: 'left' });
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#666')
         .text('Submitted via montissolessentials.com', { align: 'left' });
      doc.moveDown(1);

      // Vendor identity
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#e74d10').text('Vendor');
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#111');
      const identity = [
        ['Company Name', companyName],
        ['Focal Point', contactName],
        ['Email',       contactEmail],
        ['Phone',       contactPhone],
        ['Submitted',   submittedAt],
      ];
      for (const [k, v] of identity) {
        doc.font('Helvetica-Bold').text(k + ':', { continued: true }).font('Helvetica').text(' ' + fmtAnswer(v));
      }
      doc.moveDown(0.75);

      // Questions & answers
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#e74d10').text('Responses');
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#111');
      for (const q of VENDOR_QUESTIONS) {
        // Prevent orphaned questions at page bottom
        if (doc.y > 700) doc.addPage();
        doc.font('Helvetica-Bold').text(q.label);
        doc.font('Helvetica').fillColor('#333').text(fmtAnswer(answers[q.key]), { indent: 12 });
        doc.fillColor('#111');
        doc.moveDown(0.4);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function handleVendorQuestionnaire(req, res) {
  const body = req.body || {};
  if (body.website) return res.status(200).json({ ok: true }); // honeypot
  if (typeof body.elapsedMs === 'number' && body.elapsedMs < 3000) {
    return res.status(200).json({ ok: true });
  }

  const companyName  = String(body.companyName  || '').trim().slice(0, 200);
  const contactName  = String(body.contactName  || '').trim().slice(0, 120);
  const contactEmail = String(body.contactEmail || '').trim().slice(0, 180);
  const contactPhone = String(body.contactPhone || '').trim().slice(0, 40);

  if (!companyName || !contactName || !contactEmail || !contactPhone) {
    return res.status(400).json({ ok: false, error: 'Please provide company name and contact details.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }
  // Required questionnaire fields (matching client-side required attrs)
  const requiredKeys = [
    'q3_unPreQualified', 'q5_aircraftDetails', 'q7_aoc', 'q8_dangerousGoods',
    'q9_icao', 'q13_insurance', 'q10_mob', 'q11_fleetList', 'q12_paxCapacity',
    'q14_pap', 'q16_papRecent', 'q18_responseTime', 'q20_flightHourCost', 'q21_caaExemption',
  ];
  for (const k of requiredKeys) {
    const v = body[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
      return res.status(400).json({ ok: false, error: `Please answer all required questions (missing: ${k}).` });
    }
  }

  // Build the PDF
  const submittedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const answers = {};
  for (const q of VENDOR_QUESTIONS) answers[q.key] = body[q.key];

  let pdfBuffer;
  try {
    pdfBuffer = await buildVendorPdf({ companyName, contactName, contactEmail, contactPhone, submittedAt, answers });
  } catch (err) {
    console.error('Vendor questionnaire PDF error:', err);
    return res.status(500).json({ ok: false, error: 'Could not generate PDF. Please try again.' });
  }

  // Sanitize for filename
  const safeCompany = companyName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'vendor';
  const filename = `Aviation_Vendor_Questionnaire_${safeCompany}.pdf`;

  try {
    await resend.emails.send({
      from: 'Montissol Essentials <noreply@montissolessentials.com>',
      to: ['elyseem@montissolessentials.com'],
      replyTo: contactEmail,
      subject: `[Vendor Questionnaire] ${companyName} — ${contactName}`,
      html: `
        <h2>Aviation Vendor Pre-Qualification Questionnaire</h2>
        <p>A new vendor has submitted the aviation questionnaire.</p>
        <table style="border-collapse:collapse; font-family:Arial,sans-serif; font-size:14px;">
          <tr><td style="padding:6px 12px; font-weight:bold; color:#555;">Company</td><td style="padding:6px 12px;">${esc(companyName)}</td></tr>
          <tr><td style="padding:6px 12px; font-weight:bold; color:#555;">Focal Point</td><td style="padding:6px 12px;">${esc(contactName)}</td></tr>
          <tr><td style="padding:6px 12px; font-weight:bold; color:#555;">Email</td><td style="padding:6px 12px;"><a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a></td></tr>
          <tr><td style="padding:6px 12px; font-weight:bold; color:#555;">Phone</td><td style="padding:6px 12px;">${esc(contactPhone)}</td></tr>
          <tr><td style="padding:6px 12px; font-weight:bold; color:#555;">Submitted</td><td style="padding:6px 12px;">${esc(submittedAt)}</td></tr>
        </table>
        <p>Full responses are attached as <strong>${esc(filename)}</strong>. Reply to this email to reach ${esc(contactName)} directly.</p>
      `,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    });
  } catch (err) {
    console.error('Vendor questionnaire email error:', err);
    const msg = err?.message || err?.statusCode || JSON.stringify(err);
    return res.status(500).json({ ok: false, error: 'Resend: ' + msg });
  }

  // Confirmation to the vendor — polite acknowledgment
  try {
    await resend.emails.send({
      from: 'Montissol Essentials <noreply@montissolessentials.com>',
      to: [contactEmail],
      replyTo: 'elyseem@montissolessentials.com',
      subject: 'Questionnaire received — Montissol Essentials',
      html: `
        <p>Hello ${esc(contactName)},</p>
        <p>Thank you for submitting the Aviation Vendor Pre-Qualification Questionnaire on behalf of <strong>${esc(companyName)}</strong>. Our team will review your responses and follow up as needed.</p>
        <p>Sincerely,<br>Montissol Essentials LLC<br><em>"Simplifying Success"</em></p>
      `,
    });
  } catch (err) {
    console.warn('Vendor confirmation email failed (non-fatal):', err?.message || err);
  }

  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (req.query?.type === 'vendor-questionnaire') {
    return handleVendorQuestionnaire(req, res);
  }

  const {
    fullName,
    companyName,
    email,
    phone,
    serviceType,
    industry,
    location,
    startDate,
    frequency,
    scope,
    budget,
    timeline,
    siteAccess,
    website, // honeypot
    elapsedMs,
  } = req.body || {};

  // Honeypot spam trap
  if (website) {
    return res.status(200).json({ ok: true });
  }

  // Too fast = bot (real humans take at least a few seconds to fill out the form)
  if (typeof elapsedMs === 'number' && elapsedMs < 3000) {
    return res.status(200).json({ ok: true });
  }

  if (!fullName || !email || !serviceType || !location || !scope) {
    return res.status(400).json({ ok: false, error: 'Please complete all required fields.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  // Gibberish detection: flag strings that look like random keyboard mashing
  if (looksLikeGibberish(fullName) || looksLikeGibberish(location) || looksLikeGibberish(scope)) {
    console.log('Spam rejected (gibberish):', { fullName, location });
    return res.status(200).json({ ok: true });
  }

  try {
    const freqList = Array.isArray(frequency) ? frequency.join(', ') : (frequency || '');
    await resend.emails.send({
      from: 'Montissol Essentials <noreply@montissolessentials.com>',
      to: ['info@montissolessentials.com', 'ElyseeM@MontissolEssentials.com'],
      replyTo: email,
      subject: `[Quote Request] ${serviceType} — ${location} — ${fullName}`,
      html: `
        <h2>New Quote Request</h2>
        <table style="border-collapse:collapse; width:100%; max-width:640px; font-family:Arial,sans-serif;">
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555; width:180px;">Name</td><td style="padding:10px;">${esc(fullName)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Company / Organization</td><td style="padding:10px;">${esc(companyName || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Email</td><td style="padding:10px;"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Phone</td><td style="padding:10px;">${esc(phone || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Service Type</td><td style="padding:10px;">${esc(serviceType)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Industry / Environment</td><td style="padding:10px;">${esc(industry || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Service Location</td><td style="padding:10px;">${esc(location)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Desired Start Date</td><td style="padding:10px;">${esc(startDate || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Frequency</td><td style="padding:10px;">${esc(freqList || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Budget</td><td style="padding:10px;">${esc(budget || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Timeline</td><td style="padding:10px;">${esc(timeline || 'N/A')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px; font-weight:bold; color:#555;">Site Access / Requirements</td><td style="padding:10px;">${esc(siteAccess || 'N/A')}</td></tr>
          <tr><td style="padding:10px; font-weight:bold; color:#555; vertical-align:top;">Scope / Details</td><td style="padding:10px; white-space:pre-wrap;">${esc(scope)}</td></tr>
        </table>
        <hr style="margin:24px 0; border:none; border-top:1px solid #eee;">
        <p style="color:#999; font-size:12px;">Sent from the Montissol Essentials Request a Quote form.</p>
      `,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Quote request error:', error);
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

// Heuristic spam detection for random keyboard-mashing strings.
function looksLikeGibberish(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 6) return false;

  // Strip spaces/punctuation for analysis
  const letters = s.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 6) return false;

  // Check 1: mixed-case chaos — ALTERnATInG or raNDoMcAsE within a single "word"
  const words = s.split(/\s+/).filter(w => /[a-zA-Z]/.test(w));
  for (const w of words) {
    if (w.length < 6) continue;
    let caseChanges = 0;
    for (let i = 1; i < w.length; i++) {
      const prev = w[i - 1];
      const cur = w[i];
      if (/[a-zA-Z]/.test(prev) && /[a-zA-Z]/.test(cur)) {
        if (prev === prev.toLowerCase() && cur === cur.toUpperCase()) caseChanges++;
        else if (prev === prev.toUpperCase() && cur === cur.toLowerCase()) caseChanges++;
      }
    }
    // If more than 1/3 of the word has case changes, it's gibberish
    if (caseChanges >= Math.max(3, Math.floor(w.length / 3))) return true;
  }

  // Check 2: very low vowel ratio (real text typically 30-45% vowels)
  const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
  const ratio = vowels / letters.length;
  if (letters.length >= 8 && (ratio < 0.15 || ratio > 0.75)) return true;

  // Check 3: 5+ consecutive consonants (e.g., "pfPuHWZL")
  if (/[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{5,}/.test(letters)) return true;

  return false;
}
