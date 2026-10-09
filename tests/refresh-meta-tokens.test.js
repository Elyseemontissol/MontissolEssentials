import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, pickPage } from '../scripts/refresh-meta-tokens.mjs';

test('parseEnv reads vercel env pull output', () => {
  const env = parseEnv('# Created by Vercel CLI\nFB_PAGE_ID="123"\nIG_ACCESS_TOKEN="IGAA\\"x\\""\nMULTI="a\\nb"\nBARE=plain\n');
  assert.equal(env.FB_PAGE_ID, '123');
  assert.equal(env.IG_ACCESS_TOKEN, 'IGAA"x"');
  assert.equal(env.MULTI, 'a\nb');
  assert.equal(env.BARE, 'plain');
});

test('pickPage matches FB_PAGE_ID as string or number', () => {
  const accounts = { data: [{ id: '111', name: 'Other' }, { id: '222', name: 'Montissol' }] };
  assert.equal(pickPage(accounts, 222).name, 'Montissol');
  assert.equal(pickPage(accounts, '999'), null);
  assert.equal(pickPage({}, '222'), null);
});

test('pickPage without FB_PAGE_ID: single Page, or the one Montissol Page', () => {
  assert.equal(pickPage({ data: [{ id: '1', name: 'Solo' }] }, '').id, '1');
  assert.equal(pickPage({ data: [{ id: '1', name: 'Other' }, { id: '2', name: 'Montissol Essentials' }] }, '').id, '2');
  assert.equal(pickPage({ data: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] }, ''), null);
});

test('missingPermissions lists required Instagram permissions not granted', async () => {
  const { missingPermissions } = await import('../scripts/refresh-meta-tokens.mjs');
  const perms = { data: [
    { permission: 'pages_show_list', status: 'granted' },
    { permission: 'instagram_basic', status: 'declined' },
  ] };
  assert.deepEqual(missingPermissions(perms), ['instagram_basic', 'instagram_content_publish']);
  assert.deepEqual(missingPermissions({ data: [
    { permission: 'pages_show_list', status: 'granted' },
    { permission: 'instagram_basic', status: 'granted' },
    { permission: 'instagram_content_publish', status: 'granted' },
  ] }), []);
});
