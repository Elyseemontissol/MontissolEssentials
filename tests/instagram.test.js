import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postToInstagram } from '../api/_lib/instagram.js';

test('Instagram creates an image container and publishes it', async () => {
  const calls = [];
  const responses = [{ id: 'container-1' }, { id: 'media-1' }];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: Object.fromEntries(options.body) });
    return {
      ok: true,
      status: 200,
      async json() { return responses.shift(); },
    };
  };

  const result = await postToInstagram({
    instagramUserId: 'ig-123',
    accessToken: 'token',
    caption: 'A thoughtful caption',
    imageUrl: 'https://example.com/image.png',
    fetchImpl,
  });

  assert.equal(result.id, 'media-1');
  assert.match(calls[0].url, /ig-123\/media$/);
  assert.equal(calls[0].body.image_url, 'https://example.com/image.png');
  assert.equal(calls[0].body.caption, 'A thoughtful caption');
  assert.match(calls[1].url, /ig-123\/media_publish$/);
  assert.equal(calls[1].body.creation_id, 'container-1');
});

test('Instagram requires an image URL', async () => {
  await assert.rejects(
    postToInstagram({
      instagramUserId: 'ig-123',
      accessToken: 'token',
      caption: 'Caption',
      imageUrl: null,
    }),
    /requires a public image URL/,
  );
});
