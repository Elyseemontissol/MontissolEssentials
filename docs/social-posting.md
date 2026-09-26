# Instagram and Facebook Posting

The social agent prepares a square image and one caption for both platforms. It
emails the owner an approval preview. Approval publishes Facebook first and then
Instagram, records both result IDs, and advances the content rotation.

## Content rotation

Drafts rotate through:

1. Business inspiration
2. Treating employees well
3. Why Montissol Essentials is a good place to work
4. Recruiting

Vercel prepares drafts every Monday and Thursday at 13:00 UTC. Posts are never
published until the email approval link is used.

## Required Meta setup

- An Instagram Professional account connected to the Montissol Essentials
  Facebook Page
- A Meta app with Facebook Page and Instagram content-publishing access
- A Page access token with the permissions required to publish Page and
  Instagram content

Set these Vercel environment variables:

```text
FB_PAGE_ID
FB_PAGE_ACCESS_TOKEN
IG_USER_ID
IG_ACCESS_TOKEN
META_GRAPH_VERSION
FB_APPROVAL_SECRET
```

The existing caption, image, storage, and email variables are also required:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
BLOB_READ_WRITE_TOKEN
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
RESEND_API_KEY
OWNER_EMAIL
PUBLIC_BASE_URL
```

`META_GRAPH_VERSION` should be set to the version enabled for the Meta app. The
code defaults to `v25.0` only when the variable is absent.

## Targeted hiring campaigns

Open the draft endpoint with campaign fields to create a recruiting draft
instead of using the next rotating theme:

```text
/api/fb-draft?project=PROJECT&role=ROLE&location=LOCATION&apply_url=URL
```

URL-encode each value. The supplied project, role, location, and apply link are
given to the caption generator as the only approved hiring facts. The resulting
draft still requires email approval.

Each project receives its own public description and interest-form page. Form
submissions are stored under that project's identifier and emailed to the
Montissol team. Authorized staff can review candidates grouped by project at:

```text
/job-candidates-admin.html
```

The dashboard uses the same `ADMIN_PASSWORD` as the site's existing admin
tools. Candidate pages are marked `noindex` and applicant records are only
returned by the authenticated API.

Add `dry=1` while testing. A dry-run approval does not publish to either
platform.

## Failure behavior

- If Facebook fails, the draft is restored for retry.
- If Facebook succeeds but Instagram fails, the draft is not restored, which
  prevents a duplicate Facebook post. The approval page shows the Instagram
  error for follow-up.
- If image generation fails, Facebook receives a text-only post and Instagram
  is skipped because Instagram image publishing requires a public image URL.
