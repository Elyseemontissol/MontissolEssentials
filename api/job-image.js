// Returns a 1080x1080 PNG for job posts: Job-Post.png with a "NOW HIRING —
// {title}" banner burned in at the bottom. Meta's Graph API fetches this URL
// when the FB/IG job post is published, so it must be publicly accessible.
//
//   GET /api/job-image?title=Janitors%20and%20Supervisor
import sharp from 'sharp';

function escXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Break the title into up to 2 lines so long titles wrap nicely. Simple
// character-budget split at the nearest space — good enough for role names.
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

    const lines = wrap(title, 22);
    const titleFontSize = lines.length === 2 ? 60 : 76;
    const titleSvgLines = lines.map((line, i) => {
      const y = 990 + (i - (lines.length - 1) / 2) * (titleFontSize + 8);
      return `<text x="540" y="${y}" font-family="Arial Black, Arial, sans-serif" font-size="${titleFontSize}" font-weight="900" fill="white" text-anchor="middle" dominant-baseline="middle">${escXml(line)}</text>`;
    }).join('\n');

    const svg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
        <defs>
          <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
            <stop offset="100%" stop-color="rgba(0,0,0,0.65)"/>
          </linearGradient>
        </defs>
        <rect x="0" y="720" width="1080" height="360" fill="url(#fade)"/>
        <rect x="0" y="830" width="1080" height="250" fill="rgba(220,38,38,0.94)"/>
        <text x="540" y="890" font-family="Arial Black, Arial, sans-serif" font-size="44" font-weight="900" fill="white" text-anchor="middle" letter-spacing="4">NOW HIRING</text>
        ${titleSvgLines}
      </svg>
    `);

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
