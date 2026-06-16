import { redis, KEYS } from './_lib/redis.js';
import { verifyToken } from './_lib/tokens.js';
import { advanceTheme } from './_lib/themes.js';
import { postToPage } from './_lib/facebook.js';

// Single magic-link endpoint for all three FB draft actions.
// The action (approve | edit | reject) is encoded in the HMAC token,
// so the URL is uniform (/api/fb-action?token=…) and the action
// cannot be tampered with from the URL.

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function htmlPage(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:48px auto;padding:24px;color:#111;}
      .ok{color:#16a34a;} .err{color:#dc2626;} pre{background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto;}</style>
      </head><body>${body}</body></html>`,
  };
}

function htmlEditShell(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Edit FB draft</title>
    <style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:680px;margin:32px auto;padding:24px;}
    textarea{width:100%;height:260px;font:14px ui-monospace,monospace;padding:12px;border:1px solid #ccc;border-radius:6px;}
    button{padding:12px 24px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;}
    img{max-width:100%;border-radius:8px;margin:12px 0;}</style>
    </head><body>${body}</body></html>`;
}

function send(res, page) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(page.status).send(page.html);
}

function sendShell(res, status, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(htmlEditShell(body));
}

async function readBody(req) {
  if (req.body) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

// ── Approve ──
async function handleApprove(payload, req, res) {
  const key = KEYS.draft(payload.draftId);
  const raw = await redis.getdel(key);
  if (!raw) return send(res, htmlPage('Already used', '<h1 class="err">Draft already used or expired</h1>', 410));
  const draft = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (draft.dry_run) {
    return send(res, htmlPage('Dry run',
      `<h1 class="ok">Dry run — would have posted</h1><pre>${escape(draft.caption)}</pre>`));
  }

  const message = [draft.caption, (draft.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  try {
    const result = await postToPage({
      pageId: process.env.FB_PAGE_ID,
      accessToken: process.env.FB_PAGE_ACCESS_TOKEN,
      message,
      imageUrl: draft.image_url || null,
    });
    await advanceTheme(redis);
    await redis.lpush(KEYS.history, JSON.stringify({
      ts: new Date().toISOString(),
      theme: draft.theme,
      draft_id: payload.draftId,
      status: 'posted',
      fb_post_id: result.id || result.post_id,
      caption: draft.caption,
    }));
    await redis.ltrim(KEYS.history, 0, 49);
    return send(res, htmlPage('Posted',
      `<h1 class="ok">Posted ✓</h1><p>Facebook ID: <code>${escape(result.id || result.post_id)}</code></p>`));
  } catch (err) {
    await redis.set(key, JSON.stringify(draft), { ex: 72 * 60 * 60 });
    await redis.lpush(KEYS.history, JSON.stringify({
      ts: new Date().toISOString(),
      theme: draft.theme,
      draft_id: payload.draftId,
      status: 'error',
      error: err.message,
    }));
    await redis.ltrim(KEYS.history, 0, 49);
    return send(res, htmlPage('Post failed',
      `<h1 class="err">Facebook rejected the post</h1><pre>${escape(err.message)}</pre><p>Draft is preserved — fix the issue and click the link again.</p>`, 502));
  }
}

// ── Reject ──
async function handleReject(payload, req, res) {
  const key = KEYS.draft(payload.draftId);
  const raw = await redis.getdel(key);
  if (!raw) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(410).send('<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:48px auto;padding:24px;"><h1>Already used or expired</h1></body></html>');
  }
  const draft = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (!draft.dry_run) await advanceTheme(redis);
  await redis.lpush(KEYS.history, JSON.stringify({
    ts: new Date().toISOString(),
    theme: draft.theme,
    draft_id: payload.draftId,
    status: 'rejected',
  }));
  await redis.ltrim(KEYS.history, 0, 49);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send('<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:48px auto;padding:24px;"><h1>Rejected ✓</h1><p>Theme rotation advanced. Next week tries a different angle.</p></body></html>');
}

// ── Edit ──
async function handleEdit(payload, token, req, res) {
  const key = KEYS.draft(payload.draftId);

  if (req.method === 'POST') {
    const body = await readBody(req);
    const newCaption = (body.caption || '').toString();
    const raw = await redis.getdel(key);
    if (!raw) return sendShell(res, 410, '<h1>Draft expired</h1>');
    const draft = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (draft.dry_run) {
      return sendShell(res, 200, `<h1>Dry run — would post:</h1><pre>${escape(newCaption)}</pre>`);
    }
    const message = [newCaption, (draft.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
    try {
      const result = await postToPage({
        pageId: process.env.FB_PAGE_ID,
        accessToken: process.env.FB_PAGE_ACCESS_TOKEN,
        message,
        imageUrl: draft.image_url || null,
      });
      await advanceTheme(redis);
      await redis.lpush(KEYS.history, JSON.stringify({
        ts: new Date().toISOString(), theme: draft.theme, draft_id: payload.draftId,
        status: 'posted_edited', fb_post_id: result.id || result.post_id, caption: newCaption,
      }));
      await redis.ltrim(KEYS.history, 0, 49);
      return sendShell(res, 200, `<h1 style="color:#16a34a;">Posted ✓</h1>`);
    } catch (err) {
      await redis.set(key, JSON.stringify({ ...draft, caption: newCaption }), { ex: 72 * 60 * 60 });
      return sendShell(res, 502, `<h1 style="color:#dc2626;">Post failed</h1><pre>${escape(err.message)}</pre>`);
    }
  }

  // GET: render the form
  const raw = await redis.get(key);
  if (!raw) return sendShell(res, 410, '<h1>Draft expired or already used</h1>');
  const draft = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const img = draft.image_url ? `<img src="${draft.image_url}" alt="">` : '';
  sendShell(res, 200, `
    <h1>Edit draft</h1>
    <p>Theme: ${escape(draft.theme)}</p>
    ${img}
    <form method="POST" action="?token=${escape(token)}">
      <textarea name="caption">${escape(draft.caption)}</textarea>
      <p>Hashtags (kept): ${escape((draft.hashtags || []).join(' '))}</p>
      <button type="submit">Post to Facebook</button>
    </form>
  `);
}

// ── Dispatcher ──
export default async function handler(req, res) {
  const token = req.query?.token;
  if (!token) return send(res, htmlPage('Missing token', '<h1 class="err">Missing token</h1>', 400));

  const payload = verifyToken(token, process.env.FB_APPROVAL_SECRET);
  if (!payload) return send(res, htmlPage('Invalid token', '<h1 class="err">Invalid or forged token</h1>', 401));

  if (payload.action === 'approve') return handleApprove(payload, req, res);
  if (payload.action === 'reject')  return handleReject(payload, req, res);
  if (payload.action === 'edit')    return handleEdit(payload, token, req, res);

  return send(res, htmlPage('Unknown action', '<h1 class="err">Unknown action</h1>', 400));
}
