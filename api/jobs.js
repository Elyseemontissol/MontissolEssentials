// Unified job endpoint. Modes:
//   GET  /api/jobs?id=<slug>&page=1   → renders the public job page HTML,
//                                       or a "Position closed" page if the
//                                       job's Redis meta has expired (30d).
//   GET  /api/jobs                    → admin-authed candidate list (JSON).
//   POST /api/jobs                    → public form submission.
//
// Job metadata lives in Redis under `jobs:meta:<projectId>` with a 30-day
// TTL. When it expires the meta vanishes automatically — the page renderer
// then serves a 410 Gone with a friendly message. Candidate lists live
// under `jobs:candidates:<projectId>` with NO TTL, so historical
// applicants stay visible in the admin panel forever.
import { Resend } from 'resend';
import { Redis } from '@upstash/redis';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import Busboy from 'busboy';

// Vercel's Node runtime auto-parses JSON bodies for us (req.body arrives
// as an object). Multipart/form-data is NOT auto-parsed — req arrives as
// a raw stream that we feed through busboy in parseMultipartBody() below.

const PROJECTS = {
  'hop-brook-lake': 'Janitorial Services - Hop Brook Lake and Naugatuck River Basin, Middlebury, CT',
  'spo': 'Janitorial Services - Sault Project Office (SPO), St. Marys Falls Canal, Sault Ste. Marie, MI',
  'ks019': 'Custodial Services - KS019 Army Reserve Facility, Manhattan, KS',
  'nws-melbourne': 'Janitorial Services - National Weather Service Office, Melbourne, FL',
  'hords-creek-lake': 'Park Cleaning Services - Hords Creek Lake, Coleman, TX',
  'albany-va-parking': 'Patient Assisted Parking Services - Samuel S. Stratton VA Medical Center, Albany, NY',
};

// Resume upload limits + accepted types.
const RESUME_MAX_BYTES = 4 * 1024 * 1024; // 4 MB (well under Vercel's request limit)
const RESUME_ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const redis = Redis.fromEnv();

// 30 days in seconds — job page + form availability window.
const JOB_META_TTL_SECONDS = 30 * 24 * 60 * 60;

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function metaKey(projectId) {
  return `jobs:meta:${projectId}`;
}

// Called from api/fb-draft.js when a campaign draft is created (non-dry).
// Writes the full page metadata to Redis with a 30d TTL so the dynamic
// page renderer + form submissions work for the next month, then expire
// automatically.
export async function saveJobMeta(meta) {
  if (!meta.projectId) throw new Error('saveJobMeta requires projectId');
  const payload = {
    ...meta,
    postedAt: meta.postedAt || new Date().toISOString(),
  };
  await redis.set(metaKey(meta.projectId), JSON.stringify(payload), { ex: JOB_META_TTL_SECONDS });
}

async function readJobMeta(projectId) {
  const raw = await redis.get(metaKey(projectId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export function validateInterest(body = {}) {
  const data = {
    projectId: clean(body.projectId, 80),
    name: clean(body.name, 120),
    email: clean(body.email, 180),
    phone: clean(body.phone, 40),
    experience: clean(body.experience, 3000),
    canPerform: clean(body.canPerform, 3),
    workConstraints: clean(body.workConstraints, 1000),
  };

  if (!PROJECTS[data.projectId]) return { error: 'This position is not available.' };
  if (!data.name || !data.email || !data.phone || !data.experience || !data.canPerform) {
    return { error: 'Please complete all required fields.' };
  }
  if (!['yes', 'no'].includes(data.canPerform)) {
    return { error: 'Please indicate whether you can perform the essential duties.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return { error: 'Please enter a valid email address.' };
  }
  if (!/^[+()\d\s.-]{7,40}$/.test(data.phone)) {
    return { error: 'Please enter a valid phone number.' };
  }
  if (data.experience.length < 20) {
    return { error: 'Please tell us a little more about your experience.' };
  }

  return { data: { ...data, project: PROJECTS[data.projectId] } };
}

function authorized(req) {
  const expected = process.env.ADMIN_PASSWORD || '';
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !token) return false;
  const left = Buffer.from(token);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Read a multipart/form-data POST into { fields, resume }. Fields come
// back as strings; the single accepted file is buffered up to
// RESUME_MAX_BYTES. Extra files or an oversize resume are rejected.
function parseMultipartBody(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: RESUME_MAX_BYTES } });
    } catch (err) { return reject(err); }
    const fields = {};
    let resume = null;
    let sizeLimitHit = false;
    let typeRejected = null;

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'resume') { stream.resume(); return; }
      if (info.mimeType && !RESUME_ALLOWED_MIME.has(info.mimeType)) {
        typeRejected = info.mimeType;
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { sizeLimitHit = true; });
      stream.on('end', () => {
        if (!sizeLimitHit && !typeRejected) {
          resume = {
            buffer: Buffer.concat(chunks),
            filename: info.filename || 'resume',
            mimeType: info.mimeType || 'application/octet-stream',
          };
        }
      });
    });
    bb.on('error', reject);
    bb.on('close', () => {
      if (sizeLimitHit) return reject(new Error('Resume file is larger than 4 MB. Please attach a smaller file.'));
      if (typeRejected) return reject(new Error(`Resume file type not accepted (${typeRejected}). Please attach a PDF, DOC, DOCX, or plain-text file.`));
      resolve({ fields, resume });
    });
    req.pipe(bb);
  });
}

async function handleSubmit(req, res) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  const isMultipart = contentType.startsWith('multipart/form-data');

  let body;
  let resume = null;
  if (isMultipart) {
    try {
      const parsed = await parseMultipartBody(req);
      body = parsed.fields;
      resume = parsed.resume;
      // Numeric fields come back as strings from FormData.
      if (body.elapsedMs != null) body.elapsedMs = Number(body.elapsedMs);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message || 'Could not read the submission.' });
    }
  } else {
    body = req.body || {};
  }

  if (body.website) {
    console.warn('jobs POST: honeypot triggered, dropping silently');
    return res.status(200).json({ ok: true });
  }
  if (typeof body.elapsedMs === 'number' && body.elapsedMs < 1000) {
    console.warn(`jobs POST: too-fast (${body.elapsedMs}ms), dropping silently`);
    return res.status(200).json({ ok: true });
  }

  // Simple arithmetic verification — the page embeds mathA / mathB /
  // mathOp as hidden fields (generated client-side on load). Bots that
  // POST directly to /api/jobs without rendering the page will be
  // missing these entirely and fail the check.
  const mathA = Number(body.mathA);
  const mathB = Number(body.mathB);
  const mathOp = String(body.mathOp || '');
  const mathAnswer = Number(body.mathAnswer);
  if (!Number.isFinite(mathA) || !Number.isFinite(mathB) || !Number.isFinite(mathAnswer) || !['+', '-'].includes(mathOp)) {
    return res.status(400).json({ ok: false, error: 'Please solve the verification equation before submitting.' });
  }
  const mathExpected = mathOp === '+' ? mathA + mathB : mathA - mathB;
  if (mathAnswer !== mathExpected) {
    return res.status(400).json({ ok: false, error: 'The verification answer is incorrect. Please solve the equation and try again.' });
  }

  const result = validateInterest(body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });

  // Reject submissions for jobs whose 30-day meta window has closed.
  // Belt-and-suspenders on top of the page-render 410 — protects against
  // stale FB/IG post links being submitted via curl or a cached form.
  const meta = await readJobMeta(result.data.projectId);
  if (!meta) {
    return res.status(410).json({
      ok: false,
      error: 'This position is no longer accepting applications.',
    });
  }

  const { project, name, email, phone, experience, canPerform, workConstraints } = result.data;
  const candidate = {
    id: randomUUID(),
    projectId: result.data.projectId,
    project,
    name,
    email,
    phone,
    experience,
    canPerform,
    workConstraints,
    submittedAt: new Date().toISOString(),
    resumeFilename: resume?.filename || null,
    resumeMimeType: resume?.mimeType || null,
    resumeSize: resume?.buffer.length || null,
  };

  try {
    await redis.lpush(`jobs:candidates:${candidate.projectId}`, JSON.stringify(candidate));
    await redis.ltrim(`jobs:candidates:${candidate.projectId}`, 0, 999);
    await redis.sadd('jobs:projects', candidate.projectId);
  } catch (error) {
    console.error('Job interest storage error:', error);
    return res.status(500).json({
      ok: false,
      error: 'We could not save your information. Please try again.',
    });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const emailPayload = {
      from: 'Montissol Careers <noreply@montissolessentials.com>',
      to: ['elyseem@montissolessentials.com'],
      replyTo: email,
      subject: `[Job Interest] ${project} - ${name}${resume ? ' (resume attached)' : ''}`,
      html: `
        <h2>New Job Interest Submission</h2>
        <p style="margin:0 0 20px 0;">
          <a href="https://www.montissolessentials.com/job-candidates-admin.html" style="display:inline-block;background:#e74d10;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-family:Arial,sans-serif;font-weight:700;">Open Job Candidates admin →</a>
        </p>
        <table style="border-collapse:collapse;width:100%;max-width:640px;font-family:Arial,sans-serif;">
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;width:150px;">Position</td><td style="padding:10px;">${esc(project)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Name</td><td style="padding:10px;">${esc(name)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Email</td><td style="padding:10px;"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${esc(phone)}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Can perform essential duties</td><td style="padding:10px;">${canPerform === 'yes' ? 'Yes' : 'No'}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;vertical-align:top;">Non-medical constraints</td><td style="padding:10px;white-space:pre-wrap;">${esc(workConstraints || 'None provided')}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Resume</td><td style="padding:10px;">${resume ? `<strong>${esc(resume.filename)}</strong> (${Math.round(resume.buffer.length / 1024)} KB) — attached to this email` : '<em>Not attached</em>'}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;vertical-align:top;">Experience</td><td style="padding:10px;white-space:pre-wrap;">${esc(experience)}</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:24px;">Submitted through the Montissol Essentials careers website. Reply to this email to respond to ${esc(name)} directly.</p>
      `,
    };
    if (resume) {
      emailPayload.attachments = [{
        filename: resume.filename,
        content: resume.buffer.toString('base64'),
      }];
    }
    await resend.emails.send(emailPayload);
  } catch (error) {
    console.error('Job interest email error:', error);
  }

  return res.status(200).json({ ok: true });
}

async function handleAdminList(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const projectIds = await redis.smembers('jobs:projects');
    const projects = await Promise.all(projectIds.map(async (projectId) => {
      const raw = await redis.lrange(`jobs:candidates:${projectId}`, 0, 999);
      const candidates = raw.map((entry) => {
        if (typeof entry !== 'string') return entry;
        try { return JSON.parse(entry); } catch { return null; }
      }).filter(Boolean);
      return {
        id: projectId,
        name: candidates[0]?.project || PROJECTS[projectId] || projectId,
        candidates,
      };
    }));
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ ok: true, projects });
  } catch (error) {
    console.error('Candidate dashboard error:', error);
    return res.status(500).json({ ok: false, error: 'Could not load candidates.' });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Dynamic job-page rendering
// ────────────────────────────────────────────────────────────────────────

function jobPageJsonLd(meta) {
  const {
    projectId, projectName, headline, city, state, streetAddress, postalCode,
    paragraph1, paragraph2, postedAt,
  } = meta;
  const validThrough = new Date(new Date(postedAt).getTime() + JOB_META_TTL_SECONDS * 1000)
    .toISOString().slice(0, 10);
  const addr = {
    '@type': 'PostalAddress',
    addressLocality: city,
    addressRegion: state,
    addressCountry: 'US',
  };
  if (streetAddress) addr.streetAddress = streetAddress;
  if (postalCode) addr.postalCode = postalCode;
  const descHtml = `<p>${esc(paragraph1)}</p>` + (paragraph2 ? `<p>${esc(paragraph2)}</p>` : '');
  return {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: `${headline} — ${city}, ${state}`,
    description: descHtml,
    identifier: { '@type': 'PropertyValue', name: 'Montissol Essentials LLC', value: projectId },
    datePosted: postedAt.slice(0, 10),
    validThrough,
    employmentType: 'FULL_TIME',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Montissol Essentials LLC',
      sameAs: 'https://www.montissolessentials.com',
      logo: 'https://www.montissolessentials.com/assets/images/Header-logo.png',
    },
    jobLocation: { '@type': 'Place', address: addr },
    applicantLocationRequirements: { '@type': 'Country', name: 'US' },
    industry: 'Facility Services / Janitorial',
    directApply: true,
    url: `https://www.montissolessentials.com/job-${projectId}`,
  };
}

function renderJobPageHtml(meta) {
  const {
    projectId, projectName, headline, subheadline, kicker,
    city, state, h2, paragraph1, paragraph2,
  } = meta;
  const pageTitle = `${headline} - ${city}, ${state} | Montissol Essentials`;
  const jsonLd = JSON.stringify(jobPageJsonLd(meta));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(`Express interest in ${headline.toLowerCase()} opportunities with Montissol Essentials in ${city}, ${state}.`)}">
  <meta property="og:title" content="${esc(headline)} - ${esc(city)}, ${esc(state)}">
  <meta property="og:description" content="${esc(subheadline)}">
  <meta property="og:image" content="https://www.montissolessentials.com/assets/Social/Job-Post.png">
  <meta property="og:url" content="https://www.montissolessentials.com/job-${esc(projectId)}">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/images/favicon.png">
  <style>
    /* Visually hide the honeypot spam trap so real applicants never see
       it. Kept in the tab order for accessibility tools but off-screen.
       (assets/styles.css may not carry a rule for this on all pages.) */
    .form-honeypot { position: absolute !important; left: -9999px !important; width: 1px !important; height: 1px !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none; }
  </style>
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<div id="shared-header"></div>

<main>
  <section class="hero hero--services hero--zoom job-interest-hero">
    <div class="hero-split__bg" style="background-image:url('/assets/images/facility-operations.jpg');"></div>
    <div class="hero-split__overlay"></div>
    <div class="container hero-split__inner">
      <div class="hero-split__kicker"><span class="dot"></span><span>${esc(kicker)}</span></div>
      <h1 class="hero-split__headline">${esc(headline)}</h1>
      <p class="hero-split__sub">${esc(subheadline)}</p>
      <div class="hero-split__actions">
        <a class="btn primary" href="#interest-form">Express Interest</a>
        <a class="btn outline" href="/careers" style="border-color:#fff;color:#fff;">View Careers</a>
      </div>
    </div>
  </section>

  <section class="section job-interest-section">
    <div class="container job-interest-layout">
      <div class="job-interest-copy">
        <div class="mini-kicker"><span class="dot"></span><span>Local Opportunity</span></div>
        <h2>${esc(h2)}</h2>
        <p>${esc(paragraph1)}</p>
        ${paragraph2 ? `<p>${esc(paragraph2)}</p>` : ''}
        <div class="job-interest-note">
          <strong>What happens next</strong>
          <p>Share your contact information and relevant experience. Our team will review your submission and contact qualified candidates as project staffing details become available.</p>
        </div>
      </div>

      <div class="contact-form-panel job-interest-form-panel" id="interest-form">
        <h2 class="contact-form-title">Express Your Interest</h2>
        <p class="job-interest-form-intro">Fields marked with an asterisk are required.</p>
        <form id="jobInterestForm" novalidate>
          <input type="hidden" name="projectId" value="${esc(projectId)}">
          <input class="form-honeypot" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <div class="field"><label for="name">Full name <span class="req">*</span></label><input id="name" name="name" type="text" autocomplete="name" maxlength="120" required></div>
          <div class="field"><label for="email">Email address <span class="req">*</span></label><input id="email" name="email" type="email" autocomplete="email" maxlength="180" required></div>
          <div class="field"><label for="phone">Phone number <span class="req">*</span></label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="40" required></div>
          <div class="field"><label for="experience">Relevant experience <span class="req">*</span></label><textarea id="experience" name="experience" minlength="20" maxlength="3000" required placeholder="Tell us about your janitorial, custodial, cleaning, or facility experience."></textarea></div>
          <div class="field"><label for="canPerform">Can you perform the essential duties of this role, with or without reasonable accommodation? <span class="req">*</span></label><select id="canPerform" name="canPerform" required><option value="">Select an answer</option><option value="yes">Yes</option><option value="no">No</option></select></div>
          <div class="field"><label for="workConstraints">Are there any non-medical scheduling, transportation, or work-location limitations we should consider?</label><textarea id="workConstraints" name="workConstraints" maxlength="1000" placeholder="Optional. Please do not provide medical or disability information."></textarea></div>
          <div class="field"><label for="resume">Attach your r&eacute;sum&eacute; <span style="color:#666;font-weight:400;">(optional &mdash; PDF, DOC, DOCX, or TXT, up to 4&nbsp;MB)</span></label><input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"></div>
          <div class="field"><label for="mathAnswer">Verification &mdash; solve this to submit <span class="req">*</span><br><span style="font-size:.95rem;font-weight:400;">What is <span id="mathQuestion">&mdash;</span>?</span></label><input id="mathAnswer" name="mathAnswer" type="text" inputmode="numeric" pattern="-?[0-9]{1,4}" maxlength="4" autocomplete="off" required style="max-width:140px;"><input type="hidden" name="mathA" id="mathA"><input type="hidden" name="mathB" id="mathB"><input type="hidden" name="mathOp" id="mathOp"></div>
          <button class="contact-submit job-interest-submit" type="submit">Submit Interest</button>
          <p class="form-status" id="formStatus" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>
  </section>
</main>

<div id="shared-footer"></div>
<script src="/assets/shared.js"></script>
<script>
  (function () {
    var form = document.getElementById('jobInterestForm');
    var status = document.getElementById('formStatus');
    var button = form.querySelector('button[type="submit"]');
    var startedAt = Date.now();

    // Generate a small verification equation on page load. Naive spam
    // bots that POST /api/jobs directly without loading the page won't
    // have the hidden mathA/mathB/mathOp fields at all, so the server
    // rejects them. Real users just add two small numbers.
    var mA = Math.floor(Math.random() * 9) + 1;
    var mB = Math.floor(Math.random() * 9) + 1;
    var mOp = Math.random() < 0.5 ? '+' : '-';
    if (mOp === '-' && mB > mA) { var t = mA; mA = mB; mB = t; }
    var mExpected = mOp === '+' ? mA + mB : mA - mB;
    document.getElementById('mathQuestion').textContent = mA + ' ' + mOp + ' ' + mB;
    document.getElementById('mathA').value = String(mA);
    document.getElementById('mathB').value = String(mB);
    document.getElementById('mathOp').value = mOp;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      // Client-side verification check — immediate feedback if the
      // math answer is wrong. Server re-verifies as the source of
      // truth (see handleSubmit in api/jobs.js).
      var typedAnswer = Number(document.getElementById('mathAnswer').value);
      if (!Number.isFinite(typedAnswer) || typedAnswer !== mExpected) {
        status.className = 'form-status is-error';
        status.textContent = 'The verification answer is incorrect. Please solve the equation and try again.';
        return;
      }

      button.disabled = true;
      button.textContent = 'Submitting...';
      status.className = 'form-status';
      status.textContent = '';
      // If the applicant attached a résumé, submit as multipart/form-data
      // so the file rides along with the rest of the fields. Otherwise
      // send JSON (matches the existing behavior + saves bandwidth).
      var resumeInput = form.querySelector('input[name="resume"]');
      var hasResume = resumeInput && resumeInput.files && resumeInput.files.length > 0;
      var response;
      try {
        if (hasResume) {
          var fd = new FormData(form);
          fd.append('elapsedMs', String(Date.now() - startedAt));
          response = await fetch('/api/jobs', { method: 'POST', body: fd });
        } else {
          var data = Object.fromEntries(new FormData(form).entries());
          delete data.resume; // empty file blob is not JSON-serializable and not needed
          data.elapsedMs = Date.now() - startedAt;
          response = await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
        }
        var contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error('The application form is not available in this static preview.');
        }
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Submission failed.');
        form.reset();
        status.className = 'form-status is-success';
        status.textContent = 'Thank you. Your information has been received.';
        button.textContent = 'Submitted';
      } catch (error) {
        status.className = 'form-status is-error';
        status.textContent = error.message || 'We could not submit your information. Please try again.';
        button.disabled = false;
        button.textContent = 'Submit Interest';
      }
    });
  })();
</script>
</body>
</html>`;
}

function renderExpiredHtml(projectId) {
  const projectName = PROJECTS[projectId] || '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Position Closed | Montissol Essentials</title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/images/favicon.png">
</head>
<body>
<div id="shared-header"></div>
<main>
  <section class="section" style="min-height:60vh;display:flex;align-items:center;justify-content:center;padding:80px 24px;">
    <div style="max-width:560px;text-align:center;">
      <h1 style="margin:0 0 12px 0;">Position Closed</h1>
      ${projectName ? `<p style="color:#666;margin:0 0 12px 0;">${esc(projectName)}</p>` : ''}
      <p style="margin:0 0 32px 0;">This job posting is no longer accepting applications. Check our current openings below or contact us directly.</p>
      <a href="/careers" class="btn primary">View Current Openings</a>
    </div>
  </section>
</main>
<div id="shared-footer"></div>
<script src="/assets/shared.js"></script>
</body>
</html>`;
}

async function handleJobPage(req, res) {
  const projectId = String(req.query?.id || '').trim().slice(0, 80);
  if (!projectId) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(renderExpiredHtml(''));
  }
  const meta = await readJobMeta(projectId);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!meta) {
    // Either never posted or 30-day TTL expired. Same friendly page either way.
    return res.status(410).send(renderExpiredHtml(projectId));
  }
  return res.status(200).send(renderJobPageHtml(meta));
}

// ──────────────────────────────────────────────────────────────────────
// Directory: /job (and /jobs) → lists every currently-active listing
// (i.e., every PROJECTS entry whose Redis meta hasn't expired yet).
// ──────────────────────────────────────────────────────────────────────

function renderJobDirectoryHtml(items) {
  const now = Date.now();
  function relPosted(iso) {
    if (!iso) return '';
    const days = Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000));
    if (days === 0) return 'Posted today';
    if (days === 1) return 'Posted 1 day ago';
    return `Posted ${days} days ago`;
  }
  const cards = items.length ? items.map(({ slug, meta }) => {
    const snippet = String(meta.paragraph1 || '').slice(0, 240);
    const trimmed = meta.paragraph1 && meta.paragraph1.length > 240 ? snippet + '…' : snippet;
    return `
      <a class="job-card" href="/job-${esc(slug)}.html">
        <div class="job-card__kicker">${esc(meta.kicker || 'Now Hiring')}</div>
        <h2 class="job-card__title">${esc(meta.headline || 'Open Position')}</h2>
        <p class="job-card__where">${esc(meta.subheadline || `${meta.city || ''}${meta.state ? ', ' + meta.state : ''}`)}</p>
        <p class="job-card__snippet">${esc(trimmed)}</p>
        <div class="job-card__foot">
          <span class="job-card__date">${esc(relPosted(meta.postedAt))}</span>
          <span class="job-card__cta">View position &amp; apply →</span>
        </div>
      </a>`;
  }).join('') : `
      <div class="job-empty">
        <h2>No open positions at this time</h2>
        <p>We aren't actively recruiting for any specific project right now. Please check back soon — new opportunities are posted here as they become available.</p>
        <p><a class="btn primary" href="/careers">Learn about careers at Montissol</a></p>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Positions | Montissol Essentials</title>
  <meta name="description" content="Current job openings at Montissol Essentials LLC. Apply directly online.">
  <meta property="og:title" content="Open Positions | Montissol Essentials">
  <meta property="og:description" content="Explore current job openings at Montissol Essentials LLC and apply directly online.">
  <meta property="og:url" content="https://www.montissolessentials.com/careers">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/images/favicon.png">
  <style>
    .job-directory { max-width: 960px; margin: 0 auto; padding: 48px 24px 64px; }
    .job-directory h1 { margin: 8px 0 12px; }
    .job-directory > p.lede { color: #ccc; margin: 0 0 32px; font-size: 1.05rem; max-width: 640px; }
    .job-list { display: grid; grid-template-columns: 1fr; gap: 20px; }
    .job-card { display: block; padding: 24px 28px; border: 1px solid rgba(231,77,16,.28); border-radius: 14px; text-decoration: none; color: inherit; background: rgba(255,255,255,.02); transition: border-color .15s, transform .15s, background .15s; }
    .job-card:hover, .job-card:focus { border-color: #e74d10; background: rgba(231,77,16,.06); transform: translateY(-2px); outline: none; }
    .job-card__kicker { font-size: .78rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #e74d10; }
    .job-card__title { margin: 8px 0 4px; font-size: 1.5rem; line-height: 1.2; }
    .job-card__where { margin: 0 0 12px; color: #cfcfcf; font-weight: 600; }
    .job-card__snippet { margin: 0; color: #a8a8a8; line-height: 1.55; }
    .job-card__foot { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; flex-wrap: wrap; gap: 12px; }
    .job-card__date { color: #888; font-size: .85rem; }
    .job-card__cta { color: #e74d10; font-weight: 700; }
    .job-empty { text-align: center; padding: 48px 24px; border: 1px dashed rgba(255,255,255,.15); border-radius: 14px; }
    .job-empty h2 { margin: 0 0 12px; }
    .job-empty p { margin: 0 0 16px; color: #b0b0b0; }
    @media (min-width: 720px) { .job-list { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<div id="shared-header"></div>

<main>
  <section class="section">
    <div class="container job-directory">
      <div class="mini-kicker"><span class="dot"></span><span>Careers</span></div>
      <h1>Open Positions</h1>
      <p class="lede">Explore our current opportunities at Montissol Essentials. Click any position below to view details and apply directly online.</p>
      <div class="job-list">
        ${cards}
      </div>
    </div>
  </section>
</main>

<div id="shared-footer"></div>
<script src="/assets/shared.js"></script>
</body>
</html>`;
}

async function handleJobDirectory(req, res) {
  // Pull every project's meta in parallel; drop the ones whose 30-day
  // window has already lapsed (readJobMeta returns null for expired keys).
  const slugs = Object.keys(PROJECTS);
  const metas = await Promise.all(slugs.map((s) => readJobMeta(s)));
  const items = slugs
    .map((slug, i) => ({ slug, meta: metas[i] }))
    .filter((x) => x.meta)
    .sort((a, b) => String(b.meta.postedAt || '').localeCompare(String(a.meta.postedAt || '')));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60'); // small cache — updates propagate quickly
  return res.status(200).send(renderJobDirectoryHtml(items));
}

export default async function handler(req, res) {
  if (req.method === 'POST') return handleSubmit(req, res);
  // Treat HEAD like GET so crawlers / uptime pings don't see spurious
  // 405s. The response.send() body is discarded by the runtime for HEAD.
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.query?.directory === '1') return handleJobDirectory(req, res);
    if (req.query?.page === '1') return handleJobPage(req, res);
    return handleAdminList(req, res);
  }
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
