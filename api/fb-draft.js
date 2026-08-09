import { randomUUID } from 'node:crypto';
import { redis, KEYS } from './_lib/redis.js';
import { SYSTEM_PROMPT } from './_lib/system-prompt.js';
import { getNextTheme } from './_lib/themes.js';
import { generateCaption, generateInspireCaption } from './_lib/caption.js';
import { fetchPexelsImage } from './_lib/pexels.js';
import { INSPIRE_POSTS, INSPIRE_KEYS } from './_lib/inspire.js';
import { publishSocial } from './_lib/publish.js';
import { signToken } from './_lib/tokens.js';
import { renderApprovalEmail, sendApprovalEmail } from './_lib/email.js';
import { saveJobMeta } from './jobs.js';

const DRAFT_TTL_SECONDS = 72 * 60 * 60;
const DEFAULT_OWNER_EMAIL = 'Info@MontissolEssentials.com';
export const config = { maxDuration: 60 };

function appBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://www.montissolessentials.com';
}

// Derive the projectId slug from an apply URL like
// `https://.../job-<slug>.html#interest-form`. Returns null for URLs that
// aren't in our /job-<slug>.html pattern (e.g. careers.html fallback).
function projectIdFromApplyUrl(applyUrl) {
  const m = String(applyUrl || '').match(/\/job-([a-z0-9-]+)\.html/i);
  return m ? m[1].toLowerCase() : null;
}

// Derive page metadata (headline, kicker, city/state, copy) from the
// campaign params. Called by fb-draft handler when a real (non-dry)
// campaign draft is created so the dynamic /job-<slug>.html page can
// render for the next 30 days.
function buildJobMeta(campaign) {
  const projectId = campaign.projectId || projectIdFromApplyUrl(campaign.applyUrl);
  if (!projectId) return null;
  const [city, state] = String(campaign.location || '').split(',').map((s) => s.trim());
  // Pull "Janitorial Services" / "Custodial Services" out of the project name if present.
  const headlineMatch = String(campaign.project || '').match(/\b(janitorial|custodial)\s+services\b/i);
  const headline = headlineMatch ? headlineMatch[0].replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : 'Facility Services';
  const kicker = state ? `Now Recruiting in ${state}` : 'Now Recruiting';
  const h2 = `Now Hiring: ${campaign.role}`;
  const paragraph1 = `Montissol Essentials is inviting residents in and around ${city || 'the local area'}${state ? ', ' + state : ''} to express interest in ${campaign.role} opportunities supporting ${campaign.project}.`;
  const paragraph2 = campaign.description || 'We want to hear from dependable people who take pride in helping keep public spaces clean, safe, and welcoming.';
  return {
    projectId,
    projectName: campaign.project,
    headline,
    subheadline: campaign.project,
    kicker,
    city: city || '',
    state: state || '',
    h2,
    paragraph1,
    paragraph2,
  };
}

function cleanCampaign(query = {}) {
  const limit = (value, max) => String(value || '').trim().slice(0, max);

  // Shorthand: ?job=Welders[&description=...] → hiring campaign for the given
  // role at Hop Brook Lake, linking to the interest form. Uses Job-Post.png.
  if (query.job) {
    return {
      projectId: 'hop-brook-lake',
      project: 'Janitorial Services - Hop Brook Lake, Middlebury, CT',
      role: limit(query.job, 120),
      location: 'Middlebury, CT',
      applyUrl: `${appBaseUrl()}/job-hop-brook-lake.html#interest-form`,
      description: limit(query.description, 600) || null,
      isJobPost: true,
    };
  }

  if (!query.project && !query.role && !query.location && !query.apply_url) return null;
  const applyUrl = limit(query.apply_url, 300) || `${appBaseUrl()}/careers.html`;
  return {
    projectId: limit(query.project_id, 80) || projectIdFromApplyUrl(applyUrl),
    project: limit(query.project, 120) || 'Not specified',
    role: limit(query.role, 120) || 'Not specified',
    location: limit(query.location, 120) || 'Not specified',
    applyUrl,
    description: limit(query.description, 600) || null,
    isJobPost: true,
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

async function handleInspire(req, res, dryRun) {
  try {
    const nextRaw = await redis.get(INSPIRE_KEYS.next);
    const next = Number(nextRaw) || 0;

    // Exhausted the pre-designed queue → email owner once, then stay silent
    // until they extend api/_lib/inspire.js. The flag has a 30-day TTL so
    // if they add more content and reset the counter, they'll get a fresh
    // reminder later if the new queue also runs out.
    if (next >= INSPIRE_POSTS.length) {
      const alreadyNotified = await redis.get(INSPIRE_KEYS.exhaustedNotified);
      if (!alreadyNotified) {
        await sendApprovalEmail({
          apiKey: process.env.RESEND_API_KEY,
          to: process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL,
          subject: 'Inspire post queue empty - add more content',
          html: `<p>The daily inspire rotation has posted all ${INSPIRE_POSTS.length} panels. Add more entries to <code>api/_lib/inspire.js</code> and drop matching PNGs into <code>assets/Social/Inspire/</code> to keep the daily series going.</p><p>To reset the counter after adding content: set the Redis key <code>${INSPIRE_KEYS.next}</code> back to the index where the new content starts, and delete <code>${INSPIRE_KEYS.exhaustedNotified}</code>.</p>`,
        });
        await redis.set(INSPIRE_KEYS.exhaustedNotified, '1', { ex: 30 * 24 * 3600 });
      }
      return res.status(200).json({ ok: true, exhausted: true });
    }

    const post = INSPIRE_POSTS[next];
    const imageUrl = `${appBaseUrl()}/assets/Social/Inspire/${post.image}`;

    let captionResult;
    try {
      captionResult = await generateInspireCaption({
        message: post.message,
        visual: post.visual,
        systemPrompt: SYSTEM_PROMPT,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    } catch (err) {
      await new Promise((r) => setTimeout(r, 8_000));
      captionResult = await generateInspireCaption({
        message: post.message,
        visual: post.visual,
        systemPrompt: SYSTEM_PROMPT,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }

    const message = `${captionResult.caption}${captionResult.hashtags?.length ? '\n\n' + captionResult.hashtags.join(' ') : ''}`;

    // Dry-runs skip publishing AND skip advancing the counter; useful for
    // eyeballing what today's caption would say without burning a slot.
    if (dryRun) {
      return res.status(200).json({
        ok: true, dry_run: true, inspire_index: next,
        image: post.image, caption: captionResult.caption, hashtags: captionResult.hashtags,
      });
    }

    // Auto-publish — inspire posts skip the approval-email flow entirely.
    // On FB failure we email an alert and DO NOT advance the counter so
    // tomorrow's cron retries the same panel.
    let publishResult;
    try {
      publishResult = await publishSocial(message, imageUrl);
    } catch (publishErr) {
      console.error('inspire publish failed:', publishErr);
      await appendHistory({
        ts: new Date().toISOString(),
        theme: 'inspire',
        status: 'inspire_publish_failed',
        inspire_index: next,
        caption: captionResult.caption,
        error: publishErr.message,
      });
      try {
        await sendApprovalEmail({
          apiKey: process.env.RESEND_API_KEY,
          to: process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL,
          subject: `Inspire auto-publish FAILED (panel ${next + 1}/${INSPIRE_POSTS.length})`,
          html: `<p>Inspire auto-publish failed on panel <b>${next + 1}</b> (${post.image}). Counter not advanced — tomorrow's cron will retry the same panel.</p><pre>${publishErr.stack || publishErr.message}</pre>`,
        });
      } catch { /* swallow */ }
      return res.status(502).json({ ok: false, inspire_index: next, error: publishErr.message });
    }

    await appendHistory({
      ts: new Date().toISOString(),
      theme: 'inspire',
      status: publishResult.instagramStatus === 'posted' ? 'inspire_posted' : 'inspire_posted_fb_only',
      inspire_index: next,
      caption: captionResult.caption,
      fb_post_id: publishResult.facebook?.id || publishResult.facebook?.post_id || null,
      ig_post_id: publishResult.instagram?.id || null,
      instagram_status: publishResult.instagramStatus,
      instagram_error: publishResult.instagramError || null,
    });

    // Advance counter now that FB succeeded (IG failure alone doesn't
    // block advancing — the panel was already posted to FB).
    await redis.set(INSPIRE_KEYS.next, next + 1);

    return res.status(200).json({
      ok: true, inspire_index: next,
      fb_post_id: publishResult.facebook?.id || null,
      ig_post_id: publishResult.instagram?.id || null,
      instagram_status: publishResult.instagramStatus,
    });
  } catch (err) {
    console.error('inspire handler failed:', err);
    try {
      await sendApprovalEmail({
        apiKey: process.env.RESEND_API_KEY,
        to: process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL,
        subject: 'Inspire auto-publish FAILED (caption generation)',
        html: `<p>Inspire failed before publishing (likely caption generation). Counter not advanced.</p><pre>${err.stack || err.message}</pre>`,
      });
    } catch { /* swallow */ }
    return res.status(500).json({ ok: false, error: err.message });
  }
}

export default async function handler(req, res) {
  const dryRun = req.query?.dry === '1';
  if (req.query?.type === 'inspire') {
    return handleInspire(req, res, dryRun);
  }
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

    // Real campaigns: save the /job-<slug>.html page metadata to Redis
    // with a 30-day TTL so the dynamic page renderer + interest form
    // are live for the next month, then auto-expire. Dry runs skip this
    // (they're for previewing captions, not creating live pages).
    if (campaign && !dryRun) {
      const meta = buildJobMeta(campaign);
      if (meta) {
        try {
          await saveJobMeta(meta);
        } catch (err) {
          console.error('saveJobMeta failed (non-fatal, draft continues):', err.message);
        }
      }
    }

    // Image strategy: campaigns bring their own image; everything else pulls a
    // themed stock photo from Pexels (free API, credit appended to caption below).
    // On any failure (API down, no results, missing key) we fall back to the
    // static default so the flow still succeeds and Instagram still gets an image.
    let imageUrl;
    let pexelsAttribution = null;
    if (campaign) {
      // All campaign posts (hiring pushes) use the Job-Post.png base image
      // with a "NOW HIRING - {role}" banner burned in by /api/job-image.
      // Draft-id in the URL guarantees Meta fetches a fresh render each
      // time (busts any Vercel edge cache from a prior draft with the
      // same role after code changes to the overlay renderer).
      imageUrl = `${appBaseUrl()}/api/job-image?title=${encodeURIComponent(campaign.role)}&location=${encodeURIComponent(campaign.location || '')}&v=${Date.now()}`;
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
