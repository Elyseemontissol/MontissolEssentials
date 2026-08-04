// Cross-post a caption + image to Facebook page and Instagram business
// account. Extracted from fb-action.js so multiple callers (approval flow
// AND auto-publish flow like the daily inspire cron) can share it.
//
// Return shape:
//   { facebook: { id, ... }, instagram: {...} | null, instagramStatus, instagramError? }
//
// FB failure throws. IG failure is captured on the return value so the
// caller can decide (approval path renders a 207, inspire logs the error
// and emails).
import { postToPage } from './facebook.js';
import { postToInstagram } from './instagram.js';

export async function publishSocial(message, imageUrl) {
  const facebook = await postToPage({
    pageId: process.env.FB_PAGE_ID,
    accessToken: process.env.FB_PAGE_ACCESS_TOKEN,
    message,
    imageUrl,
  });

  if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) {
    return { facebook, instagram: null, instagramStatus: 'not_configured' };
  }
  if (!imageUrl) {
    return { facebook, instagram: null, instagramStatus: 'skipped_no_image' };
  }

  try {
    const instagram = await postToInstagram({
      instagramUserId: process.env.IG_USER_ID,
      accessToken: process.env.IG_ACCESS_TOKEN,
      caption: message,
      imageUrl,
    });
    return { facebook, instagram, instagramStatus: 'posted' };
  } catch (error) {
    return { facebook, instagram: null, instagramStatus: 'failed', instagramError: error.message };
  }
}
