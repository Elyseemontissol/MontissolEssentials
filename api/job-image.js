// Returns a 1080x1080 PNG for job posts: Job-Post.png with a "NOW HIRING /
// {title}" headline burned into the empty white area in the center. Meta's
// Graph API fetches this URL when the FB/IG job post is published, so it
// must be publicly accessible.
//
//   GET /api/job-image?title=Janitors%20and%20Supervisor
//
// Font: Inter-Black.ttf is bundled into api/_lib/fonts/ and embedded as a
// base64 data URI inside an @font-face rule in the SVG. This is required
// because Vercel serverless functions don't ship with system fonts; without
// this, librsvg falls back to tofu glyphs (boxes) for every character.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_BASE64 = readFileSync(path.join(HERE, '_lib/fonts/Inter-Black.ttf')).toString('base64');
const FONT_DATA_URI = `data:font/truetype;charset=utf-8;base64,${FONT_BASE64}`;

function escXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Break the title into up to 2 lines so long titles wrap nicely. Simple
// character-budget split at word boundaries — good enough for role names.
function wrap(text, maxCharsPerLine) {
  const trimmed = String(text).trim();
  if (trimmed.length <= maxCharsPerLine) return [trimmed];
  const words = trimmed.split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const candidate = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
    if (candidate.length <= maxCharsPerLine || lines.length >= 2) {
      lines[lines.length - 1] = candidate;
    } else {
      lines.push(w);
    }
  }
  return lines.slice(0, 2);
}

export default async function handler(req, res) {
  try {
    const rawTitle = String(req.query?.title || '').trim().slice(0, 80) || 'JOIN OUR TEAM';
    const title = rawTitle.toUpperCase();

    const host = req.headers?.host || 'www.montissolessentials.com';
    const proto = req.headers?.['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}/assets/Social/Job-Post.png`;

    const baseRes = await fetch(baseUrl);
    if (!baseRes.ok) {
      return res.status(502).json({ ok: false, error: `Base image fetch failed: ${baseRes.status}` });
    }
    const baseBuf = Buffer.from(await baseRes.arrayBuffer());

    // Job-Post.png has a large empty white area in the middle — drop the text
    // there in the brand red so it lands on the design's intended headline
    // zone instead of covering the photo panels at the bottom.
    const lines = wrap(title, 18);
    const roleFontSize = lines.length === 2 ? 78 : 96;
    const lineHeight = roleFontSize + 12;
    const totalRoleHeight = lineHeight * lines.length;
    const roleTop = 540 - totalRoleHeight / 2 + roleFontSize * 0.85;

    const titleSvgLines = lines.map((line, i) => {
      const y = roleTop + i * lineHeight;
      return `<text x="540" y="${y}" text-anchor="middle" font-family="Inter" font-weight="900" font-size="${roleFontSize}" fill="#B22222">${escXml(line)}</text>`;
    }).join('\n');

    const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <style>
      @font-face {
        font-family: 'Inter';
        font-weight: 900;
        font-style: normal;
        src: url('${FONT_DATA_URI}') format('truetype');
      }
    </style>
  </defs>
  <text x="540" y="410" text-anchor="middle" font-family="Inter" font-weight="900" font-size="52" fill="#111111" letter-spacing="8">NOW HIRING</text>
  <line x1="380" y1="440" x2="700" y2="440" stroke="#B22222" stroke-width="4"/>
  ${titleSvgLines}
  <text x="540" y="700" text-anchor="middle" font-family="Inter" font-weight="900" font-size="26" fill="#111111" letter-spacing="4">APPLY TODAY</text>
</svg>`);

    const output = await sharp(baseBuf)
      .resize(1080, 1080, { fit: 'cover' })
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(output);
  } catch (error) {
    console.error('job-image error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
