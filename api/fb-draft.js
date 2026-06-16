import { randomUUID } from 'node:crypto';
import { redis, KEYS } from './_lib/redis.js';
import { SYSTEM_PROMPT } from './_lib/system-prompt.js';
import { getNextTheme } from './_lib/themes.js';
import { generateCaption } from './_lib/caption.js';
import { generateImage } from './_lib/image.js';
import { signToken } from './_lib/tokens.js';
import { renderApprovalEmail, sendApprovalEmail } from './_lib/email.js';

const DRAFT_TTL_SECONDS = 72 * 60 * 60;
export const config = { maxDuration: 60 };

function appBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://www.montissolessentials.com';
}

async function recentCaptions(limit = 4) {
  const entries = await redis.lrange(KEYS.history, 0, limit - 1);
  const out = [];
  for (const e of entries) {
    try {
      const obj = typeof e === 'string' ? JSON.parse(e) : e;
      if (obj.caption) out.push(obj.caption);
    } catch { /* skip */ }
  }
  return out;
}

async function appendHistory(entry) {
  await redis.lpush(KEYS.history, JSON.stringify(entry));
  await redis.ltrim(KEYS.history, 0, 49);
}

function actionUrls(draftId, secret) {
  const base = appBaseUrl();
  return {
    approveUrl: `${base}/api/fb-action?token=${signToken(draftId, 'approve', secret)}`,
    editUrl:    `${base}/api/fb-action?token=${signToken(draftId, 'edit', secret)}`,
    rejectUrl:  `${base}/api/fb-action?token=${signToken(draftId, 'reject', secret)}`,
  };
}

export default async function handler(req, res) {
  const dryRun = req.query?.dry === '1';
  try {
    const theme = await getNextTheme(redis);
    const weekDate = new Date().toISOString().slice(0, 10);
    const systemPrompt = SYSTEM_PROMPT;
    const recent = await recentCaptions(4);

    let captionResult;
    try {
      captionResult = await generateCaption({
        theme,
        weekDate,
        recentCaptions: recent,
        systemPrompt,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    } catch (err) {
      await new Promise((r) => setTimeout(r, 8_000));
      captionResult = await generateCaption({
        theme,
        weekDate,
        recentCaptions: recent,
        systemPrompt,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }

    const draftId = randomUUID();

    let imageUrl = null;
    try {
      imageUrl = await generateImage({
        prompt: captionResult.image_prompt,
        draftId,
        openaiKey: process.env.OPENAI_API_KEY,
        blobToken: process.env.BLOB_READ_WRITE_TOKEN,
      });
    } catch (err) {
      console.error('Image generation failed, continuing text-only:', err.message);
    }

    const draft = {
      caption: captionResult.caption,
      hashtags: captionResult.hashtags,
      image_url: imageUrl,
      theme,
      created_at: new Date().toISOString(),
      status: 'pending',
      dry_run: dryRun,
    };
    await redis.set(KEYS.draft(draftId), JSON.stringify(draft), { ex: DRAFT_TTL_SECONDS });

    const urls = actionUrls(draftId, process.env.FB_APPROVAL_SECRET);
    const html = renderApprovalEmail({
      theme,
      weekDate,
      caption: captionResult.caption,
      hashtags: captionResult.hashtags,
      imageUrl,
      ...urls,
      draftId,
      dryRun,
    });

    await sendApprovalEmail({
      apiKey: process.env.RESEND_API_KEY,
      to: process.env.OWNER_EMAIL,
      subject: `${dryRun ? 'TEST · ' : ''}FB draft for ${weekDate} — theme: ${theme}`,
      html,
    });

    await appendHistory({
      ts: new Date().toISOString(),
      theme,
      draft_id: draftId,
      status: dryRun ? 'dry_run' : 'draft_emailed',
      caption: captionResult.caption,
    });

    res.status(200).json({ ok: true, draftId, theme, dry_run: dryRun });
  } catch (err) {
    console.error('fb-draft failed:', err);
    try {
      await sendApprovalEmail({
        apiKey: process.env.RESEND_API_KEY,
        to: process.env.OWNER_EMAIL,
        subject: 'FB draft generation FAILED',
        html: `<p>Draft generation failed:</p><pre>${err.stack || err.message}</pre>`,
      });
    } catch { /* swallow */ }
    res.status(500).json({ ok: false, error: err.message });
  }
}
