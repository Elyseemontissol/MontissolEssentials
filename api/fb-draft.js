import { randomUUID } from 'node:crypto';
import { redis, KEYS } from './_lib/redis.js';
import { SYSTEM_PROMPT } from './_lib/system-prompt.js';
import { getNextTheme } from './_lib/themes.js';
import { generateCaption } from './_lib/caption.js';
import { fetchPexelsImage } from './_lib/pexels.js';
import { signToken } from './_lib/tokens.js';
import { renderApprovalEmail, sendApprovalEmail } from './_lib/email.js';

const DRAFT_TTL_SECONDS = 72 * 60 * 60;
const DEFAULT_OWNER_EMAIL = 'Info@MontissolEssentials.com';
export const config = { maxDuration: 60 };

function appBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://www.montissolessentials.com';
}

function cleanCampaign(query = {}) {
  const limit = (value, max) => String(value || '').trim().slice(0, max);

  // Shorthand: ?job=Welders[&description=...] → hiring campaign for the given
  // role at Hop Brook Lake, linking to the interest form. Uses Job-Post.png.
  if (query.job) {
    return {
      project: 'Janitorial Services - Hop Brook Lake, Middlebury, CT',
      role: limit(query.job, 120),
      location: 'Middlebury, CT',
      applyUrl: `${appBaseUrl()}/job-hop-brook-lake.html#interest-form`,
      description: limit(query.description, 600) || null,
      isJobPost: true,
    };
  }

  if (!query.project && !query.role && !query.location && !query.apply_url) return null;
  return {
    project: limit(query.project, 120) || 'Not specified',
    role: limit(query.role, 120) || 'Not specified',
    location: limit(query.location, 120) || 'Not specified',
    applyUrl: limit(query.apply_url, 300) || `${appBaseUrl()}/careers.html`,
  };
}

function campaignFallback(campaign) {
  return {
    caption: `Montissol Essentials is inviting ${campaign.location} area residents to express interest in ${campaign.role} opportunities supporting ${campaign.project}.

We want to hear from dependable people who take pride in helping keep public spaces clean, safe, and ready for the community. Janitorial, custodial, facility-maintenance, or related experience is helpful.

Interested? Tell us a little about yourself and your experience through our short online form:

${campaign.applyUrl}`,
    image_prompt: 'A professional facilities team preparing cleaning equipment for a public-site janitorial shift.',
    hashtags: ['#MiddleburyCT', '#ConnecticutJobs', '#JanitorialJobs'],
  };
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
    const campaign = cleanCampaign(req.query);
    const theme = campaign ? 'recruiting' : await getNextTheme(redis);
    const weekDate = new Date().toISOString().slice(0, 10);
    const systemPrompt = SYSTEM_PROMPT;
    const recent = await recentCaptions(4);

    let captionResult;
    if (campaign && !process.env.ANTHROPIC_API_KEY) {
      captionResult = campaignFallback(campaign);
    } else {
      try {
        captionResult = await generateCaption({
          theme,
          weekDate,
          recentCaptions: recent,
          systemPrompt,
          campaign,
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
      } catch (err) {
        await new Promise((r) => setTimeout(r, 8_000));
        captionResult = await generateCaption({
          theme,
          weekDate,
          recentCaptions: recent,
          systemPrompt,
          campaign,
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
      }
    }

    const draftId = randomUUID();

    // Image strategy: campaigns bring their own image; everything else pulls a
    // themed stock photo from Pexels (free API, credit appended to caption below).
    // On any failure (API down, no results, missing key) we fall back to the
    // static default so the flow still succeeds and Instagram still gets an image.
    let imageUrl;
    let pexelsAttribution = null;
    if (campaign) {
      // All campaign posts (hiring pushes) use the branded Job-Post image.
      imageUrl = `${appBaseUrl()}/assets/Social/Job-Post.png`;
    } else {
      try {
        const pexels = await fetchPexelsImage(theme, process.env.PEXELS_API_KEY);
        imageUrl = pexels.url;
        pexelsAttribution = pexels.attribution;
      } catch (err) {
        console.error('Pexels fetch failed, using default image:', err.message);
        imageUrl = `${appBaseUrl()}/assets/social/default.jpg`;
      }
    }

    // Pexels' terms require photographer credit — append to the caption.
    if (pexelsAttribution) {
      captionResult.caption = `${captionResult.caption}\n\n${pexelsAttribution}`;
    }

    const draft = {
      caption: captionResult.caption,
      hashtags: captionResult.hashtags,
      image_url: imageUrl,
      theme,
      created_at: new Date().toISOString(),
      status: 'pending',
      dry_run: dryRun,
      campaign,
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
      to: process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL,
      subject: `${dryRun ? 'TEST - ' : ''}Social draft for ${weekDate} - theme: ${theme}`,
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
        to: process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL,
        subject: 'FB draft generation FAILED',
        html: `<p>Draft generation failed:</p><pre>${err.stack || err.message}</pre>`,
      });
    } catch { /* swallow */ }
    res.status(500).json({ ok: false, error: err.message });
  }
}
