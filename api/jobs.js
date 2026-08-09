// Unified job-interest + candidate-admin endpoint.
//   POST /api/jobs   → public form submission (rate-limited via hidden fields).
//   GET  /api/jobs   → admin-authed candidate list.
// Adding a new hiring project? Extend PROJECTS below and add a matching
// public page like /job-<projectId>.html.
import { Resend } from 'resend';
import { Redis } from '@upstash/redis';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const PROJECTS = {
  'hop-brook-lake': 'Janitorial Services - Hop Brook Lake and Naugatuck River Basin, Middlebury, CT',
  'spo': 'Janitorial Services - Sault Project Office (SPO), St. Marys Falls Canal, Sault Ste. Marie, MI',
  'ks019': 'Custodial Services - KS019 Army Reserve Facility, Manhattan, KS',
  'nws-melbourne': 'Janitorial Services - National Weather Service Office, Melbourne, FL',
};

const redis = Redis.fromEnv();

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

async function handleSubmit(req, res) {
  const body = req.body || {};
  if (body.website) {
    console.warn('jobs POST: honeypot triggered, dropping silently');
    return res.status(200).json({ ok: true });
  }
  // Real spam bots submit sub-second; humans take longer even when rushing.
  // 1s is enough to stop bots without silently eating a fast-typing tester.
  if (typeof body.elapsedMs === 'number' && body.elapsedMs < 1000) {
    console.warn(`jobs POST: too-fast (${body.elapsedMs}ms), dropping silently`);
    return res.status(200).json({ ok: true });
  }

  const result = validateInterest(body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });

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
    await resend.emails.send({
      from: 'Montissol Careers <noreply@montissolessentials.com>',
      to: ['elyseem@montissolessentials.com'],
      replyTo: email,
      subject: `[Job Interest] ${project} - ${name}`,
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
          <tr><td style="padding:10px;font-weight:bold;vertical-align:top;">Experience</td><td style="padding:10px;white-space:pre-wrap;">${esc(experience)}</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:24px;">Submitted through the Montissol Essentials careers website. Reply to this email to respond to ${esc(name)} directly.</p>
      `,
    });
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

export default async function handler(req, res) {
  if (req.method === 'POST') return handleSubmit(req, res);
  if (req.method === 'GET') return handleAdminList(req, res);
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
