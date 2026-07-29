function graphBase() {
  return `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
}

export async function checkPageToken({ pageId, accessToken }) {
  const url = `${graphBase()}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Page token health check failed (${res.status}): ${body}`);
  }
  const identity = await res.json();
  if (String(identity.id) !== String(pageId)) {
    throw new Error(
      `Facebook credential mismatch: Vercel's token belongs to "${identity.name}" (${identity.id}), ` +
      `but FB_PAGE_ID is ${pageId}. Replace FB_PAGE_ACCESS_TOKEN with the Page access token and redeploy.`
    );
  }
  return identity;
}

export async function postToPage({ pageId, accessToken, message, imageUrl }) {
  await checkPageToken({ pageId, accessToken });
  const endpoint = imageUrl
    ? `${graphBase()}/${pageId}/photos`
    : `${graphBase()}/${pageId}/feed`;
  const params = new URLSearchParams();
  params.set('access_token', accessToken);
  params.set('message', message);
  if (imageUrl) params.set('url', imageUrl);
  const res = await fetch(endpoint, { method: 'POST', body: params });
  const json = await res.json();
  if (!res.ok || json.error) {
    const msg = json.error?.message || JSON.stringify(json);
    throw new Error(`Graph API error (${res.status}): ${msg}`);
  }
  return json;
}

export function buildFbPostUrl(pageId, postOrPhotoId) {
  return `https://www.facebook.com/${pageId}/posts/${postOrPhotoId}`;
}
