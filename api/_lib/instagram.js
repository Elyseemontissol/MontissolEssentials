// Uses the Instagram Login API (graph.instagram.com), not the Facebook Login
// API (graph.facebook.com). This pairs with `IGAA...` access tokens obtained
// through Instagram Business Login. Two-step publish:
//   1) POST /{ig-user-id}/media       → container id
//   2) POST /{ig-user-id}/media_publish with creation_id
function graphBase() {
  return `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || 'v19.0'}`;
}

async function graphPost(path, params, fetchImpl = fetch) {
  const res = await fetchImpl(`${graphBase()}/${path}`, {
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
  await new Promise((r) => setTimeout(r, 5000));

  return graphPost(`${instagramUserId}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  }, fetchImpl);
}
