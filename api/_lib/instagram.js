// Publishes to an Instagram Professional account in two steps:
//   1) POST /{ig-user-id}/media       → container id
//   2) POST /{ig-user-id}/media_publish with creation_id
// Both Meta login flavors expose those endpoints, so the host follows the token:
// Instagram Login tokens (IGAA…) use graph.instagram.com; Facebook Login tokens
// (EAA…, e.g. the never-expiring Page token) use graph.facebook.com with the
// Page's linked instagram_business_account id.
function graphBase(accessToken) {
  return String(accessToken).startsWith('IGAA')
    ? `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || 'v19.0'}`
    : `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
}

async function graphPost(path, params, fetchImpl = fetch) {
  const res = await fetchImpl(`${graphBase(params.access_token)}/${path}`, {
    method: 'POST',
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const message = json.error?.message || JSON.stringify(json);
    throw new Error(`Instagram Graph API error (${res.status}): ${message}`);
  }
  return json;
}

export async function postToInstagram({
  instagramUserId,
  accessToken,
  caption,
  imageUrl,
  fetchImpl = fetch,
  waitMs = 5000,
}) {
  if (!imageUrl) {
    throw new Error('Instagram publishing requires a public image URL');
  }

  const container = await graphPost(`${instagramUserId}/media`, {
    image_url: imageUrl,
    caption,
    access_token: accessToken,
  }, fetchImpl);

  // Instagram sometimes needs a moment to process the media container before
  // it's ready to publish. Govpaid sleeps 5s here; matching that.
  await new Promise((r) => setTimeout(r, waitMs));

  return graphPost(`${instagramUserId}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  }, fetchImpl);
}
