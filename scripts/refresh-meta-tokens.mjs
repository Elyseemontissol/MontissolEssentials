#!/usr/bin/env node
// Checks and renews the Meta tokens the social poster uses, and saves new
// ones straight into Vercel (production) so they never pass through chat,
// shell history, or a file on disk.
//
//   node scripts/refresh-meta-tokens.mjs          check both tokens, renew what's broken
//   node scripts/refresh-meta-tokens.mjs --check  only report token health
//
// Facebook: needs a long-lived *user* token once (Graph API Explorer → Generate
// Access Token → Access Token Debugger → "Extend Access Token"). From that it
// derives a Page token that never expires, and points Instagram at the same
// token through the Page's linked Instagram account.
// Instagram login tokens (IGAA…), if still in use, last 60 days and are renewed
// here while valid.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const graphBase = (env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v25.0'}`;
const IG_GRAPH = 'https://graph.instagram.com';

// Parses the KEY="value" file written by `vercel env pull`.
export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[m[1]] = value;
  }
  return out;
}

// Picks the Page entry from GET /me/accounts: the one matching FB_PAGE_ID when
// it's known, otherwise the only Page, otherwise the only one named Montissol.
export function pickPage(accounts, pageId) {
  const pages = accounts?.data ?? [];
  if (pageId) return pages.find((p) => String(p.id) === String(pageId)) ?? null;
  if (pages.length === 1) return pages[0];
  const montissol = pages.filter((p) => /montissol/i.test(p.name ?? ''));
  return montissol.length === 1 ? montissol[0] : null;
}

// Never put a token in an error message: the URL carries it.
async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

function vercel(args, input) {
  const r = spawnSync('vercel', args, {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    const last = `${r.stderr}${r.stdout}`.trim().split('\n').pop();
    throw new Error(`vercel ${args.slice(0, 2).join(' ')} failed: ${last}`);
  }
  return r.stdout;
}

function pullProductionEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-tokens-')); // 0700
  const file = path.join(dir, '.env');
  try {
    vercel(['env', 'pull', file, '--environment=production', '--yes']);
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function saveToVercel(name, value, { sensitive = false } = {}) {
  vercel(['env', 'add', name, 'production', '--force', '--yes', ...(sensitive ? ['--sensitive'] : [])], value);
}

async function askHidden(prompt) {
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(prompt);
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim();
}

async function checkFacebook(env) {
  // Vercel "sensitive" variables can't be read back, so the live token can't be tested here.
  if (!env.FB_PAGE_ACCESS_TOKEN) return { ok: false, unknown: true, detail: 'stored as a sensitive variable, so it can\'t be read back to test' };
  try {
    const me = await getJson(`${graphBase(env)}/me?fields=id,name&access_token=${encodeURIComponent(env.FB_PAGE_ACCESS_TOKEN)}`);
    if (String(me.id) !== String(env.FB_PAGE_ID)) {
      return { ok: false, detail: `token belongs to "${me.name}" (${me.id}), not FB_PAGE_ID ${env.FB_PAGE_ID}` };
    }
    return { ok: true, detail: `Page "${me.name}"` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// Instagram Login tokens (IGAA…) live on graph.instagram.com; Facebook Login
// tokens (EAA…, the Page token) reach the linked Instagram account via
// graph.facebook.com. api/_lib/instagram.js picks the host the same way.
async function checkInstagram(env) {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return { ok: false, unknown: true, detail: 'empty, or stored as a sensitive variable that can\'t be read back' };
  try {
    if (token.startsWith('IGAA')) {
      const me = await getJson(`${IG_GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
      return { ok: true, igLogin: true, detail: `@${me.username} (Instagram login token)` };
    }
    const me = await getJson(`${graphBase(env)}/${env.IG_USER_ID}?fields=username&access_token=${encodeURIComponent(token)}`);
    return { ok: true, detail: `@${me.username} (Facebook Page token)` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// Returns { page, instagram } after saving the new Page token, or null if skipped.
async function renewFacebook(env) {
  console.log(`
To renew the Facebook Page token (it will also cover Instagram):
  1. Open https://developers.facebook.com/tools/explorer
     Pick the Montissol app and add these permissions: pages_show_list,
     pages_read_engagement, pages_manage_posts, instagram_basic,
     instagram_content_publish, business_management.
     Click "Generate Access Token" and approve for the Montissol Page.
  2. Copy that token into https://developers.facebook.com/tools/debug/accesstoken
     click "Debug", then "Extend Access Token" at the bottom, and copy the new token.
`);
  const userToken = await askHidden('Paste the extended user token (input hidden), or press Enter to skip: ');
  if (!userToken) return null;

  const accounts = await getJson(`${graphBase(env)}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`);
  let page = pickPage(accounts, env.FB_PAGE_ID);
  if (!page && !env.FB_PAGE_ID && accounts.data?.length) {
    accounts.data.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.id})`));
    const n = Number(await ask('Which Page does the site post to? Number: '));
    page = accounts.data[n - 1] ?? null;
  }
  if (!page) throw new Error('That login can\'t manage the Montissol Page. Use the Facebook account that admins it.');

  const me = await getJson(`${graphBase(env)}/me?fields=id&access_token=${encodeURIComponent(page.access_token)}`);
  if (String(me.id) !== String(page.id)) throw new Error('The derived Page token did not verify.');

  try {
    const info = await getJson(`${graphBase(env)}/debug_token?input_token=${encodeURIComponent(page.access_token)}&access_token=${encodeURIComponent(userToken)}`);
    const expires = info.data?.expires_at;
    if (expires) {
      console.log(`Warning: this Page token expires ${new Date(expires * 1000).toLocaleString()}.`);
      console.log('That usually means step 2 ("Extend Access Token") was skipped.');
      if ((await ask('Save it anyway? (y/N) ')).toLowerCase() !== 'y') return null;
    } else {
      console.log('Page token never expires.');
    }
  } catch {
    console.log('Could not read the token expiry (fine if the debugger showed "Expires: Never").');
  }

  saveToVercel('FB_PAGE_ACCESS_TOKEN', page.access_token, { sensitive: true });
  console.log(`Saved FB_PAGE_ACCESS_TOKEN for Page "${page.name}" (${page.id}) to Vercel production.`);
  console.log(`The site posts to FB_PAGE_ID; if that isn't ${page.id}, the next post will say so clearly.`);

  let instagram = null;
  try {
    const linked = await getJson(`${graphBase(env)}/${page.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(page.access_token)}`);
    instagram = linked.instagram_business_account ?? null;
  } catch (err) {
    console.log(`Could not read the Page's linked Instagram account: ${err.message}`);
  }
  return { page, instagram, userToken };
}

async function renewInstagram(env, health, renewed) {
  if (renewed?.instagram) {
    saveToVercel('IG_USER_ID', renewed.instagram.id);
    saveToVercel('IG_ACCESS_TOKEN', renewed.page.access_token, { sensitive: true });
    console.log(`Instagram @${renewed.instagram.username} will now post with the same never-expiring Page token (IG_USER_ID and IG_ACCESS_TOKEN saved).`);
    return true;
  }
  if (health.ok && health.igLogin) {
    // Instagram login tokens are renewable only while valid; this resets the 60-day clock.
    const r = await getJson(`${IG_GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`);
    saveToVercel('IG_ACCESS_TOKEN', r.access_token);
    console.log(`Renewed IG_ACCESS_TOKEN for ${Math.round(r.expires_in / 86400)} more days and saved it to Vercel production.`);
    return true;
  }
  if (health.ok) return false;
  if (renewed) await explainMissingInstagram(env, renewed);
  return pasteInstagramLoginToken();
}

// Instagram permissions the Page token needs to see and publish to the linked account.
export const INSTAGRAM_PERMISSIONS = ['pages_show_list', 'instagram_basic', 'instagram_content_publish'];

export function missingPermissions(permissions, required = INSTAGRAM_PERMISSIONS) {
  const granted = new Set((permissions?.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission));
  return required.filter((p) => !granted.has(p));
}

async function explainMissingInstagram(env, renewed) {
  let missing = null;
  try {
    missing = missingPermissions(await getJson(`${graphBase(env)}/me/permissions?access_token=${encodeURIComponent(renewed.userToken)}`));
  } catch { /* fall through to the generic explanation */ }
  if (missing?.length) {
    console.log(`
Instagram isn't visible because the token is missing: ${missing.join(', ')}.
In Graph API Explorer add ${missing.length === 1 ? 'it' : 'them'}, click "Generate Access Token" again, extend it
in the Access Token Debugger, and run this script again.`);
  } else {
    console.log(`
The token has the Instagram permissions, so the Page "${renewed.page.name}" has no linked
Instagram Professional account. To link it (then run this script again):
  Facebook → switch to the Montissol Page → Settings → Linked accounts → Instagram → Connect,
  and make sure the Instagram account is a Business or Creator account.`);
  }
}

// Fallback: an Instagram-login token (IGAA…) works without linking the Page,
// but lasts 60 days. It's saved readable so this script can renew it.
async function pasteInstagramLoginToken() {
  console.log(`
Or, without linking: Meta app dashboard → Instagram → "API setup with Instagram business login"
→ "Generate token" for the Montissol Instagram account, and paste it here.`);
  const token = await askHidden('Paste the Instagram token (IGAA…, input hidden), or press Enter to skip: ');
  if (!token) return false;
  if (!token.startsWith('IGAA')) throw new Error('That isn\'t an Instagram login token (they start with IGAA).');
  const me = await getJson(`${IG_GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
  saveToVercel('IG_USER_ID', String(me.user_id));
  saveToVercel('IG_ACCESS_TOKEN', token);
  console.log(`Saved Instagram @${me.username} (IG_USER_ID ${me.user_id}) to Vercel production.`);
  console.log('This token expires in about 60 days. Run this script again within 50 days to renew it.');
  return true;
}

function redeployProduction() {
  const list = JSON.parse(vercel(['ls', '--environment', 'production', '--format', 'json']));
  const current = list.deployments?.find((d) => d.state === 'READY');
  if (!current) throw new Error('No ready production deployment found to redeploy.');
  console.log(`Redeploying ${current.url} so production picks up the new token(s)…`);
  vercel(['redeploy', current.url, '--target', 'production']);
  console.log('Redeploy finished.');
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const env = pullProductionEnv();

  const fb = await checkFacebook(env);
  const ig = await checkInstagram(env);
  console.log(`Facebook Page token: ${fb.ok ? 'OK' : fb.unknown ? 'UNKNOWN' : 'BROKEN'} (${fb.detail})`);
  console.log(`Instagram token:     ${ig.ok ? 'OK' : ig.unknown ? 'UNKNOWN' : 'BROKEN'} (${ig.detail})`);
  if (checkOnly) return;

  // A sensitive (unreadable) token can't be tested, so offer renewal; Enter skips.
  const renewed = fb.ok ? null : await renewFacebook(env);
  let changed = Boolean(renewed);
  changed = (await renewInstagram(env, ig, renewed)) || changed;

  if (changed) redeployProduction();
  else console.log('Nothing was changed.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
