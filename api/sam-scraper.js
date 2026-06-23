import { Resend } from 'resend';

const SAM_API_KEY = process.env.SAM_API_KEY;
const SAM_BASE_URL = 'https://api.sam.gov/opportunities/v2/search';
const RECIPIENT_EMAIL = 'elyseem@montissolessentials.com';

// Notice types to search
const NOTICE_TYPES = [
  { code: 'o', label: 'Solicitation' },
  { code: 'k', label: 'Combined Synopsis/Solicitation' },
  { code: 'r', label: 'Sources Sought' },
  { code: 'p', label: 'Pre-Solicitation' },
];

// NAICS codes relevant to Montissol Essentials
const NAICS_CODES = [
  '811310', // Commercial & Industrial Machinery Maintenance
  '561720', // Janitorial Services
  '561210', // Facilities Support Services
];

// Keywords to match in titles for broader cleaning/janitorial results
const KEYWORDS = [
  'cleaning', 'janitorial', 'custodial', 'housekeeping',
  'sanitation', 'facility maintenance', 'grounds maintenance',
  'dust collector', 'hepa', 'industrial cleaning',
];

function formatDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// Default fetch adapter — hits the live SAM.gov API. Injected into
// scanOpportunities so the scan logic can be tested without the network.
async function fetchFromSamGov({ ptype, ncode, postedFrom, postedTo }) {
  const params = new URLSearchParams({
    api_key: SAM_API_KEY,
    postedFrom,
    postedTo,
    ptype,
    limit: '1000',
    offset: '0',
  });
  if (ncode) params.set('ncode', ncode);

  const url = `${SAM_BASE_URL}?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAM.gov API error (${res.status}): ${text}`);
  }
  return res.json();
}

function matchesKeywords(title) {
  const lower = (title || '').toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

function deduplicateByNoticeId(opportunities) {
  const seen = new Set();
  return opportunities.filter((opp) => {
    if (seen.has(opp.noticeId)) return false;
    seen.add(opp.noticeId);
    return true;
  });
}

// Runs the full scan over every notice-type / NAICS / keyword combination.
// fetchFn is injected ({ ptype, ncode, postedFrom, postedTo }) => data so the
// logic is testable without the network. Tracks how many sub-requests failed so
// a dead API key (every request throws) is distinguishable from a genuine zero.
export async function scanOpportunities({ fetchFn, postedFrom, postedTo }) {
  let allOpportunities = [];
  let totalRequests = 0;
  let failedRequests = 0;

  for (const { code: ptype, label } of NOTICE_TYPES) {
    for (const ncode of NAICS_CODES) {
      totalRequests++;
      try {
        const data = await fetchFn({ ptype, ncode, postedFrom, postedTo });
        if (data.opportunitiesData) {
          allOpportunities.push(
            ...data.opportunitiesData.map((opp) => ({ ...opp, _searchType: label }))
          );
        }
      } catch (err) {
        failedRequests++;
        console.error(`Error fetching ${label} for NAICS ${ncode}:`, err.message);
      }
    }

    // Also search without NAICS to catch keyword matches
    totalRequests++;
    try {
      const data = await fetchFn({ ptype, ncode: null, postedFrom, postedTo });
      if (data.opportunitiesData) {
        const keywordMatches = data.opportunitiesData
          .filter((opp) => matchesKeywords(opp.title))
          .map((opp) => ({ ...opp, _searchType: label }));
        allOpportunities.push(...keywordMatches);
      }
    } catch (err) {
      failedRequests++;
      console.error(`Error fetching ${label} keyword search:`, err.message);
    }
  }

  const opportunities = deduplicateByNoticeId(allOpportunities).sort((a, b) =>
    (b.postedDate || '').localeCompare(a.postedDate || '')
  );

  return { opportunities, totalRequests, failedRequests };
}

// A scan is a *failure* (not a genuine zero) only when every request failed —
// e.g. an expired SAM.gov API key returning 401 on all calls.
export function isScanFailure({ totalRequests, failedRequests }) {
  return totalRequests > 0 && failedRequests === totalRequests;
}

function buildEmailHtml(opportunities) {
  if (opportunities.length === 0) {
    return `
      <div style="font-family:Arial,sans-serif; max-width:700px;">
        <h2 style="color:#1a365d;">SAM.gov Opportunity Scan</h2>
        <p>No new solicitations found matching your criteria for this period.</p>
        <p style="color:#999; font-size:12px;">Searched NAICS: ${NAICS_CODES.join(', ')} + cleaning/janitorial keywords</p>
      </div>
    `;
  }

  const rows = opportunities
    .map(
      (opp) => `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:12px; vertical-align:top;">
          <strong><a href="${esc(opp.uiLink || '#')}" style="color:#2563eb;">${esc(opp.title)}</a></strong>
          <br><span style="color:#666; font-size:13px;">Sol#: ${esc(opp.solicitationNumber || 'N/A')}</span>
        </td>
        <td style="padding:12px; vertical-align:top; white-space:nowrap; font-size:13px;">${esc(opp.type || opp.baseType || 'N/A')}</td>
        <td style="padding:12px; vertical-align:top; font-size:13px;">${esc(opp.naicsCode || 'N/A')}</td>
        <td style="padding:12px; vertical-align:top; font-size:13px;">${esc(opp.fullParentPathName || 'N/A')}</td>
        <td style="padding:12px; vertical-align:top; white-space:nowrap; font-size:13px;">${esc(opp.postedDate || 'N/A')}</td>
        <td style="padding:12px; vertical-align:top; white-space:nowrap; font-size:13px; color:#c53030;">${esc(opp.responseDeadLine || 'N/A')}</td>
      </tr>`
    )
    .join('');

  return `
    <div style="font-family:Arial,sans-serif; max-width:900px;">
      <h2 style="color:#1a365d;">SAM.gov Opportunity Scan</h2>
      <p><strong>${opportunities.length}</strong> opportunities found matching your criteria.</p>
      <table style="border-collapse:collapse; width:100%; font-family:Arial,sans-serif;">
        <thead>
          <tr style="background:#f7fafc; border-bottom:2px solid #cbd5e0;">
            <th style="padding:12px; text-align:left;">Title</th>
            <th style="padding:12px; text-align:left;">Type</th>
            <th style="padding:12px; text-align:left;">NAICS</th>
            <th style="padding:12px; text-align:left;">Agency</th>
            <th style="padding:12px; text-align:left;">Posted</th>
            <th style="padding:12px; text-align:left;">Deadline</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <hr style="margin:24px 0; border:none; border-top:1px solid #eee;">
      <p style="color:#999; font-size:12px;">
        Searched NAICS: ${NAICS_CODES.join(', ')} + cleaning/janitorial keywords<br>
        Generated by Montissol Essentials SAM.gov Scanner
      </p>
    </div>
  `;
}

function buildAlertHtml({ totalRequests, failedRequests, postedTo }) {
  return `
    <div style="font-family:Arial,sans-serif; max-width:700px;">
      <h2 style="color:#c53030;">⚠️ SAM.gov Scanner Failure</h2>
      <p>The scanner could <strong>not</strong> reach SAM.gov — <strong>all ${failedRequests} of ${totalRequests}</strong>
         API requests failed. This is <em>not</em> a "no opportunities" result; the scan never ran.</p>
      <p>The most common cause is an expired or invalid <code>SAM_API_KEY</code> (SAM.gov keys deactivate after ~90 days).
         Regenerate the key at sam.gov → Account Details → API Key and update it in Vercel.</p>
      <p style="color:#999; font-size:12px;">Scan window ending ${esc(postedTo)} · Searched NAICS: ${NAICS_CODES.join(', ')}</p>
    </div>
  `;
}

export default async function handler(req, res) {
  if (!SAM_API_KEY) {
    return res.status(500).json({ ok: false, error: 'SAM_API_KEY not configured' });
  }

  try {
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setDate(now.getDate() - 7);
    const postedFrom = formatDate(windowStart);
    const postedTo = formatDate(now);

    const { opportunities, totalRequests, failedRequests } = await scanOpportunities({
      fetchFn: fetchFromSamGov,
      postedFrom,
      postedTo,
    });

    const resend = new Resend(process.env.RESEND_API_KEY);

    // A total failure (e.g. dead API key) must NOT masquerade as "0 opportunities".
    // Alert loudly instead of sending a cheerful "no solicitations found" digest.
    if (isScanFailure({ totalRequests, failedRequests })) {
      console.error(`SAM scan failed: all ${failedRequests}/${totalRequests} requests failed`);
      const alertResult = await resend.emails.send({
        from: 'Montissol SAM Scanner <noreply@montissolessentials.com>',
        to: RECIPIENT_EMAIL,
        subject: `[SAM.gov] ⚠️ Scanner FAILED — check API key — ${postedTo}`,
        html: buildAlertHtml({ totalRequests, failedRequests, postedTo }),
      });
      return res.status(502).json({
        ok: false,
        error: 'SAM.gov scan failed: all API requests failed (likely invalid SAM_API_KEY)',
        totalRequests,
        failedRequests,
        emailResult: alertResult,
      });
    }

    // Send digest
    const html = buildEmailHtml(opportunities);
    console.log('Sending email via Resend...', { hasApiKey: !!process.env.RESEND_API_KEY });
    const emailResult = await resend.emails.send({
      from: 'Montissol SAM Scanner <noreply@montissolessentials.com>',
      to: RECIPIENT_EMAIL,
      subject: `[SAM.gov] ${opportunities.length} Opportunities Found — ${postedTo}`,
      html,
    });
    console.log('Resend response:', JSON.stringify(emailResult));

    return res.status(200).json({
      ok: true,
      count: opportunities.length,
      failedRequests,
      emailResult,
      message: `Email sent to ${RECIPIENT_EMAIL} with ${opportunities.length} opportunities`,
    });
  } catch (error) {
    console.error('SAM scraper error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
