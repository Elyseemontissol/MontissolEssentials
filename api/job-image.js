// Returns a 1080x1080 PNG hiring flyer for FB/IG job posts. Full canvas
// generated from scratch — no base image — so multiple roles, long titles,
// and the location badge all lay out predictably without ever running off
// the edges.
//
//   GET /api/job-image?title=Role1%20and%20Role2&location=City%2C%20ST[&url=example.com]
//
// The `title` string is split on "and" / "+" / "," / "/" into up to 5
// individual roles, each rendered as its own dashed-border pill. This
// mirrors the modern "WE'RE HIRING" flyer style the site owner prefers.
//
// Text rendering: text-to-svg pre-converts every string to SVG <path>
// outlines using the bundled Inter-Black.ttf so librsvg (sharp's SVG
// backend) never has to look up a font at render time.
import sharp from 'sharp';
import TextToSVG from 'text-to-svg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = TextToSVG.loadSync(path.join(HERE, '_lib/fonts/Inter-Black.ttf'));

// Montissol black/orange palette.
const BG = '#FFF8E7';           // warm cream
const DARK = '#0a0a0a';         // near-black
const ORANGE = '#e74d10';       // brand orange
const ORANGE_SOFT = 'rgba(231,77,16,0.28)';
const ORANGE_STRONGER = 'rgba(231,77,16,0.42)';

function textPath(text, o) {
  const d = font.getD(text, {
    x: o.x,
    y: o.y,
    fontSize: o.fontSize,
    anchor: o.anchor || 'center middle',
  });
  return `<path d="${d}" fill="${o.fill}"/>`;
}

function width(text, fontSize) {
  return font.getMetrics(text, { fontSize }).width;
}

// Shrink `fontSize` in 2px steps until `text` fits inside `maxWidth`.
function fitFontSize(text, targetFontSize, maxWidth, floor = 18) {
  let fs = targetFontSize;
  while (fs > floor && width(text, fs) > maxWidth) fs -= 2;
  return fs;
}

// Split combined role names like "Custodian and Backup Custodian" into
// individual pills. Accepts " and " / " + " / "," / "/" as separators.
function splitRoles(text) {
  return text
    .split(/\s+and\s+|\s+\+\s+|\s*[,/]\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((s) => s.toUpperCase());
}

// Simple filled map-pin shape centered on (cx, tipY). `height` is the
// full pin height in px; the pin points downward with the tip at tipY.
function pinShape(cx, tipY, height) {
  const s = height / 30;
  const tx = cx - 12 * s;
  const ty = tipY - 30 * s;
  const d =
    'M 12 30 C 12 30 24 21 24 12 C 24 5.4 18.6 0 12 0 C 5.4 0 0 5.4 0 12 C 0 21 12 30 12 30 Z ' +
    'M 12 8 C 9.8 8 8 9.8 8 12 C 8 14.2 9.8 16 12 16 C 14.2 16 16 14.2 16 12 C 16 9.8 14.2 8 12 8 Z';
  return `<g transform="translate(${tx} ${ty}) scale(${s})"><path d="${d}" fill="${ORANGE}" fill-rule="evenodd"/></g>`;
}

// Dashed-border pill with centered text. Height governs the corner radius.
function pill({ x, y, w, h, text, fontSize, color = DARK, strokeWidth = 3 }) {
  const rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="8 5" fill="none"/>`;
  const t = textPath(text, {
    x: x + w / 2,
    y: y + h / 2,
    fontSize,
    fill: color,
  });
  return rect + '\n' + t;
}

// Turn a role count into a row layout. Prefers pairs (2-across) with
// odd trailing roles centered on their own row.
function pillRows(count) {
  const rows = [];
  let i = 0;
  while (i < count) {
    if (count - i >= 2) {
      rows.push(2);
      i += 2;
    } else {
      rows.push(1);
      i += 1;
    }
  }
  return rows;
}

export default async function handler(req, res) {
  try {
    const rawTitle = String(req.query?.title || 'Custodian').trim().slice(0, 200);
    const location = String(req.query?.location || '').trim().slice(0, 80).toUpperCase();
    const websiteUrl = String(req.query?.url || 'montissolessentials.com').trim().slice(0, 80).toUpperCase();
    const roles = splitRoles(rawTitle);
    if (!roles.length) roles.push('CUSTODIAN');

    // --- Layout constants (all coordinates in the 1080x1080 canvas) ---
    const CANVAS = 1080;
    const TITLE_FONT = 200;
    const PAIR_PILL_W = 440;
    const PAIR_GAP = 24;
    const SOLO_PILL_MIN_W = 380;
    // Role pill height/gap tighten up when we have to fit 3 rows so the
    // APPLY NOW + website pills below still land inside the canvas.
    const rowCount = pillRows(roles.length).length;
    const PILL_H = rowCount >= 3 ? 56 : 66;
    const PILL_GAP = rowCount >= 3 ? 12 : 16;

    // --- Company name (top) ---
    const companyName = 'MONTISSOL ESSENTIALS LLC';
    const companyFs = 30;
    const companyText = textPath(companyName, { x: CANVAS / 2, y: 100, fontSize: companyFs, fill: DARK });

    // --- Massive WE'RE / HIRING (each on its own line) ---
    const wereFs = fitFontSize("WE'RE", TITLE_FONT, 900);
    const hiringFs = fitFontSize('HIRING', TITLE_FONT, 900);
    const wereText = textPath("WE'RE", { x: CANVAS / 2, y: 260, fontSize: wereFs, fill: DARK });
    const hiringText = textPath('HIRING', { x: CANVAS / 2, y: 450, fontSize: hiringFs, fill: DARK });

    // --- Location line with pin (below title) ---
    let locationSvg = '';
    if (location) {
      const locFs = fitFontSize(location, 40, 700);
      const locW = width(location, locFs);
      const pinH = locFs + 4;
      const pinW = pinH * (24 / 30);
      const gap = 14;
      const totalW = pinW + gap + locW;
      const startX = CANVAS / 2 - totalW / 2;
      const rowCenterY = 610;
      locationSvg =
        pinShape(startX + pinW / 2, rowCenterY + pinH / 2 - 4, pinH) +
        '\n' +
        textPath(location, {
          x: startX + pinW + gap + locW / 2,
          y: rowCenterY,
          fontSize: locFs,
          fill: DARK,
        });
    }

    // --- Role pills ---
    const rows = pillRows(roles.length);
    // Shift the whole roles/CTA stack up a bit for 3-row layouts so the
    // website pill still lands inside the canvas.
    const rolesBlockTop = rows.length >= 3 ? 660 : 680;
    const rolesBlockH = rows.length * PILL_H + (rows.length - 1) * PILL_GAP;
    let rolesSvg = '';
    let rIdx = 0;
    rows.forEach((count, row) => {
      const y = rolesBlockTop + row * (PILL_H + PILL_GAP);
      if (count === 1) {
        const text = roles[rIdx++];
        const fs = fitFontSize(text, 28, 800);
        const w = Math.max(SOLO_PILL_MIN_W, width(text, fs) + 90);
        rolesSvg += pill({ x: CANVAS / 2 - w / 2, y, w, h: PILL_H, text, fontSize: fs });
      } else {
        const left = CANVAS / 2 - PAIR_PILL_W - PAIR_GAP / 2;
        const right = CANVAS / 2 + PAIR_GAP / 2;
        for (let k = 0; k < 2; k++) {
          const text = roles[rIdx++];
          const fs = fitFontSize(text, 26, PAIR_PILL_W - 60);
          rolesSvg += pill({
            x: k === 0 ? left : right,
            y,
            w: PAIR_PILL_W,
            h: PILL_H,
            text,
            fontSize: fs,
          });
        }
      }
    });

    // --- APPLY NOW pill ---
    const applyY = rolesBlockTop + rolesBlockH + 40;
    const applyW = 300;
    const applyH = 66;
    const applyPill = pill({
      x: CANVAS / 2 - applyW / 2,
      y: applyY,
      w: applyW,
      h: applyH,
      text: 'APPLY NOW',
      fontSize: 30,
    });

    // --- Website pill (two lines: label + URL) ---
    const urlY = applyY + applyH + 20;
    const urlW = 620;
    const urlH = 92;
    const urlBox = `<rect x="${CANVAS / 2 - urlW / 2}" y="${urlY}" width="${urlW}" height="${urlH}" rx="46" ry="46" stroke="${DARK}" stroke-width="3" stroke-dasharray="8 5" fill="none"/>`;
    const urlLabel = textPath('VISIT OUR WEBSITE FOR INFORMATION', {
      x: CANVAS / 2,
      y: urlY + 30,
      fontSize: 20,
      fill: DARK,
    });
    const urlText = textPath(websiteUrl, {
      x: CANVAS / 2,
      y: urlY + 64,
      fontSize: 28,
      fill: DARK,
    });

    // --- SVG document ---
    const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect width="${CANVAS}" height="${CANVAS}" fill="${BG}"/>
  <circle cx="150" cy="130" r="150" fill="${ORANGE_SOFT}"/>
  <circle cx="30" cy="410" r="60" fill="${ORANGE_STRONGER}"/>
  <circle cx="1000" cy="500" r="115" fill="${ORANGE_SOFT}"/>
  <circle cx="90" cy="820" r="95" fill="${ORANGE_SOFT}"/>
  <circle cx="1030" cy="1030" r="160" fill="${ORANGE}"/>

  ${companyText}
  ${wereText}
  ${hiringText}
  ${locationSvg}
  ${rolesSvg}
  ${applyPill}
  ${urlBox}
  ${urlLabel}
  ${urlText}
</svg>`);

    const output = await sharp(svg).png().toBuffer();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(output);
  } catch (error) {
    console.error('job-image error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
