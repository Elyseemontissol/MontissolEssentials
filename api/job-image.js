// Returns a 1080x1080 PNG for job posts: Job-Post.png with a "NOW HIRING /
// {title}" headline burned into the empty white area in the center. Meta's
// Graph API fetches this URL when the FB/IG job post is published, so it
// must be publicly accessible.
//
//   GET /api/job-image?title=Janitors%20and%20Supervisor
//
// Font rendering: librsvg (sharp's SVG renderer) doesn't honor @font-face
// with data URIs, so instead we pre-convert every text string to SVG
// <path> outlines using text-to-svg + the bundled Inter-Black.ttf. Zero
// runtime font lookup, guaranteed to render everywhere.
import sharp from 'sharp';
import TextToSVG from 'text-to-svg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const textToSVG = TextToSVG.loadSync(path.join(HERE, '_lib/fonts/Inter-Black.ttf'));

// Split a title into up to 2 lines at word boundaries so long role names
// wrap cleanly instead of overflowing the safe area.
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

function textPath(text, options) {
  const d = textToSVG.getD(text, {
    x: options.x,
    y: options.y,
    fontSize: options.fontSize,
    anchor: options.anchor || 'center middle',
  });
  return `<path d="${d}" fill="${options.fill}"/>`;
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

    // Layout inside the white center area of Job-Post.png:
    //   NOW HIRING            (small, dark, top)
    //   ────────────           (thin red rule)
    //   {ROLE NAME}           (large, brand red, 1-2 lines)
    //   APPLY TODAY           (small, dark, bottom)
    const nowHiring = textPath('NOW HIRING', { x: 540, y: 380, fontSize: 60, fill: '#111111' });
    const applyToday = textPath('APPLY TODAY', { x: 540, y: 720, fontSize: 32, fill: '#111111' });

    const lines = wrap(title, 18);
    const roleFontSize = lines.length === 2 ? 78 : 100;
    const lineHeight = roleFontSize + 12;
    const titleBlockCenterY = 540;
    const firstLineY = titleBlockCenterY - ((lines.length - 1) * lineHeight) / 2;
    const rolePaths = lines
      .map((line, i) =>
        textPath(line, { x: 540, y: firstLineY + i * lineHeight, fontSize: roleFontSize, fill: '#B22222' })
      )
      .join('\n');

    const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  ${nowHiring}
  <line x1="380" y1="420" x2="700" y2="420" stroke="#B22222" stroke-width="4"/>
  ${rolePaths}
  ${applyToday}
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
