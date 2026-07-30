// Fetches a themed stock photo from Pexels for a FB/IG post.
// Free tier: 200 req/hr. Attribution required (returned as `attribution` string).

const PEXELS_QUERIES_BY_THEME = {
  business_inspiration: [
    'business team meeting',
    'entrepreneur working',
    'success celebration office',
    'workplace collaboration',
  ],
  employee_culture: [
    'happy work team',
    'team celebration',
    'workplace diversity',
    'coworkers laughing',
  ],
  why_work_here: [
    'professional workplace',
    'career growth',
    'team success',
    'proud worker',
  ],
  recruiting: [
    'job interview',
    'hiring team',
    'career opportunity',
    'workplace training',
  ],
  // Fallback pool — used when theme not mapped or no results.
  _default: [
    'cleaning crew',
    'facility maintenance',
    'commercial cleaning',
    'janitorial staff',
    'industrial cleaning',
  ],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function fetchPexelsImage(theme, apiKey) {
  if (!apiKey) throw new Error('PEXELS_API_KEY is required');
  const pool = PEXELS_QUERIES_BY_THEME[theme] || PEXELS_QUERIES_BY_THEME._default;
  const query = pick(pool);
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=square`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    throw new Error(`Pexels API error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (!Array.isArray(data.photos) || data.photos.length === 0) {
    throw new Error(`Pexels returned no photos for query "${query}"`);
  }
  const photo = pick(data.photos);
  // `large` is ~940px wide, well within Meta's 8MB limit and above IG's minimum.
  return {
    url: photo.src?.large || photo.src?.original,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    query,
    attribution: `📸 Photo by ${photo.photographer} / Pexels`,
  };
}
