function graphBase() {
  return `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
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

  return graphPost(`${instagramUserId}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  }, fetchImpl);
}
