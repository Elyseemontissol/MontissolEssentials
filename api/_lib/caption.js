import Anthropic from '@anthropic-ai/sdk';

export function parseCaptionResponse(raw) {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  const obj = JSON.parse(text);
  if (typeof obj.caption !== 'string' || obj.caption.length === 0) {
    throw new Error('caption missing or empty');
  }
  if (typeof obj.image_prompt !== 'string' || obj.image_prompt.length === 0) {
    throw new Error('image_prompt missing or empty');
  }
  return {
    caption: obj.caption,
    image_prompt: obj.image_prompt,
    hashtags: Array.isArray(obj.hashtags) ? obj.hashtags : [],
  };
}

export async function generateCaption({
  theme,
  weekDate,
  recentCaptions,
  systemPrompt,
  campaign,
  apiKey,
}) {
  const campaignContext = campaign
    ? [
        '',
        'Hiring campaign details (use only these supplied facts):',
        `Project: ${campaign.project}`,
        `Role: ${campaign.role}`,
        `Location: ${campaign.location}`,
        `Apply URL: ${campaign.applyUrl}`,
      ]
    : [];
  const client = new Anthropic({ apiKey });
  const userPrompt = [
    `Generate one post suitable for both Instagram and Facebook for Montissol Essentials.`,
    `Theme: ${theme}`,
    `Week of: ${weekDate}`,
    ...campaignContext,
    ``,
    `Recent posts (do not repeat hooks, phrases, or angles from these):`,
    ...recentCaptions.map((c, i) => `${i + 1}. ${c}`),
    ``,
    `Respond with ONLY a JSON object of the form:`,
    `{"caption": "<60-180 words>", "image_prompt": "<short description for an image generator>", "hashtags": ["#Tag1", "#Tag2", "#Tag3"]}`,
    `No prose, no markdown, no commentary.`,
  ].join('\n');
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return parseCaptionResponse(text);
}
