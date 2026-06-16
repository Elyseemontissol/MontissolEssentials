# Employee PTO System — Design

**Date:** 2026-06-02
**Owner:** Elysee Montissol
**Status:** Approved for implementation planning

## Goal

A self-service Paid Time Off system for Montissol Essentials employees: each employee gets 5 PTO days per calendar year (no rollover), can request time off through a web portal, and the owner approves or denies each request from a dedicated admin page. Email notifications keep both sides in the loop. Only the owner adds employees and manages balances.

## Non-goals (v1)

- No partial-day requests (whole days only).
- No accrual or rollover — flat 5 days per calendar year, lazy-reset on first access of the new year.
- No US-holiday calendar (holidays inside a request range count as workdays; can be added later).
- No team calendar, no conflict detection (the owner sees pending requests and judges).
- No employee password reset flow — if an employee can't sign in, the owner re-sets their last-4 SSN from the admin page.
- No integration with payroll, HR systems, or Google/Outlook calendars.
- No mobile app — responsive web only.
- No payroll-style PTO accrual over time — full 5 immediately on add.

## Background — current site

- Vercel static + serverless (`api/*.js`). Existing admin auth pattern: admin password stored in Upstash Redis (`admin:password`), exchanged for a short-lived bearer token used in subsequent calls. The invoice admin uses this today.
- Stack already in place: Upstash Redis (`@upstash/redis`), Resend (`resend`), Stripe (`stripe`), Anthropic/OpenAI/Vercel Blob for other features.

The PTO system reuses the existing admin password and email/storage stack — only new code is the PTO domain.

## Architecture

```
EMPLOYEE  ──▶ /pto.html  (new page; public URL, name + last-4 SSN gate)
              │
              ├──▶ POST /api/pto-public {action:"login", name, ssn4}
              │     server loads employee set, finds match by normalized
              │     name + verified ssn4 hash → returns {employee, balance,
              │     history} or 401
              │
              └──▶ POST /api/pto-public {action:"request", name, ssn4,
                     startDate, endDate, reason}
                    re-verify, validate, save pending request,
                    email OWNER_EMAIL with HMAC-signed Approve/Deny links

OWNER  ──▶ /pto-admin.html  (new page; not in public nav; bookmark)
            │  admin password gate (same as invoice admin)
            │
            ├──▶ POST/PATCH/DELETE /api/pto  {bearer admin token}
            │     employees CRUD + manual balance adjust
            │
            └──▶ POST /api/pto  {bearer admin token, action:"decide", requestId, decision}
                  on approve: re-check balance, decrement, mark approved
                  on deny: mark denied with optional note
                  email the employee the outcome

OWNER (from alert email)  ──▶ GET /api/pto-decision?token=<HMAC>
                                same decide logic, one-time-use via getdel
```

**Stack**

| Concern | Tool | Already in project? |
|---------|------|---------------------|
| Serverless | Vercel `api/*.js` | Yes |
| Storage | Upstash Redis (`@upstash/redis`) | Yes |
| Email | Resend (`resend`) | Yes |
| Admin auth | Existing `admin:password` + bearer token | Yes |
| SSN-4 hashing | `bcrypt` (`bcryptjs`) | New |

## Components

### `/pto.html` — Employee portal (new page)

Two-screen flow on a single page:

**Sign-in screen**
- Full name (text), Last 4 of SSN (4-digit numeric).
- Submit → `POST /api/pto-public` `{action:"login", name, ssn4}`.
- On 401: generic "Sign-in failed" message (no info about which field was wrong).
- After 5 failed attempts on the same name within 15 min: 429 for 15 min.

**Portal screen (after successful sign-in)**
- Header: greeting + balance (`{n} days remaining of 5`).
- Request form: start date, end date (auto-counts weekdays in the range), reason (text, required, ≤500 chars), Submit Request button.
- Request history: status (pending / approved / denied), date range, days, decision note (if denied).

**Client-side session model**
- After login, the page keeps `{name, ssn4}` in JavaScript memory (NOT `localStorage`/`sessionStorage`) and re-sends them with every API call.
- Closing the tab logs the employee out automatically — no cookies, no tokens.
- The server re-verifies on every call, so a stolen client-side state isn't reusable elsewhere.

### `/pto-admin.html` — Owner admin page (new page)

Admin password prompt on load (reuses existing admin auth — issues a short-lived bearer token, same as invoice admin). After login, two stacked panels:

**Pending requests panel**
- List of all pending requests with: employee name, date range, days, balance impact ("Balance: 3 → would be 0"), reason.
- Per-row Approve / Deny buttons.
- Deny opens an inline prompt for an optional reason (then submits).
- Collapsible "Decided" section showing the last 50 approved/denied requests for an audit trail.

**Employees panel**
- List of employees: name, email, current balance.
- Per-row actions: Edit (name/email), Re-set last-4 SSN, Adjust balance (with note), Delete (confirm-protected).
- "+ Add Employee" form: full name, email, last-4 SSN (validated `^\d{4}$`).
- On Add: server generates random salt, hashes ssn4 with bcrypt, sets `balanceDays=5`, `lastResetYear=current year`.
- Delete removes the employee record; existing requests keep the `employeeName` snapshot so the audit trail survives.

### `api/pto-public.js` — Employee-facing endpoint

Handles `login` and `request` actions. No admin auth.
- `login`: verify name + ssn4, return `{employee:{id,name,balanceDays}, history:[...]}` or 401.
- `request`: re-verify name + ssn4; validate dates (start ≤ end, today or later) and reason; compute weekday count; reject if days > balance; save request with status `pending`; email owner with Approve/Deny magic-links.
- Rate-limit hooks (see Security below).

### `api/pto.js` — Admin-authenticated endpoint

Bearer token required (same as invoice admin).
- `GET ?resource=employees` — list employees.
- `GET ?resource=requests&status=pending|decided` — list requests.
- `POST ?resource=employees` — create employee.
- `PATCH ?resource=employees&id=...` — update name/email, re-set ssn4, or adjust balance.
- `DELETE ?resource=employees&id=...` — delete employee.
- `POST ?resource=decide&id=...` body `{decision: "approve"|"deny", note?: string}` — decide a request.

### `api/pto-decision.js` — Email magic-link decision endpoint

GET with `?token=<HMAC>`. Token encodes `{requestId, decision}`. When the alert email is generated, a single **claim key per request** is written: `pto:decision-claim:{requestId}` → `"unused"`, 72h TTL. Both Approve and Deny tokens point to the same claim key. The endpoint:
1. Verifies the HMAC. Invalid → 401.
2. Atomic `getdel` on `pto:decision-claim:{requestId}`. Missing → 410 "Already decided or expired". This guarantees one-time use across both buttons: clicking either button consumes the single shared claim, so the other button immediately stops working too.
3. Applies the decision via the same code path as the admin endpoint.
Returns an HTML confirmation page.

The admin-portal Approve/Deny buttons go through `/api/pto` (bearer auth) and consume the same claim key, so an email decision and an admin-portal decision can't both fire on the same request.

### `api/_lib/pto-auth.js` — Helper

- `hashSsn4(ssn4)` → `{hash, salt}` using `bcryptjs`.
- `verifySsn4(ssn4, hash, salt)` → boolean, constant-time.
- `findEmployee(name, ssn4)` — loads all employees, normalizes name (lowercase, trim, collapse whitespace), iterates, verifies hash on name matches, returns the matching employee or null.

### `api/_lib/pto-dates.js` — Helper

- `countWeekdays(startDate, endDate)` — counts Mon–Fri in `[startDate, endDate]` inclusive. Throws on `end<start`.
- Date parsing/validation as a pure function — unit-testable.

### `api/_lib/pto-rate-limit.js` — Helper

- `checkAndRecordAttempt(redis, key, max, windowSeconds)` — sliding window counter in Redis. Returns `{allowed, remaining, retryAfterSec}`. Reset by `clearAttempts(redis, key)` on successful sign-in.

### `api/_lib/pto-tokens.js` — HMAC magic-link helper

Same shape as `api/_lib/tokens.js` from the FB agent: `signToken(requestId, decision, secret)` / `verifyToken(token, secret)`. Reuses the proven HMAC-SHA256 + base64url pattern.

### `api/_lib/pto-email.js` — Email templates

- `renderOwnerAlertEmail(request, approveUrl, denyUrl)` — Resend HTML email body.
- `renderEmployeeDecisionEmail(request, decision, note)` — Resend HTML email body.
- `sendOwnerAlert({apiKey, to, ...})` and `sendEmployeeDecision({apiKey, to, ...})` — Resend wrappers.

## Data model (Upstash Redis)

| Key | Type | Contents |
|-----|------|----------|
| `pto:employee:{id}` | JSON string | `{id, name, nameKey, email, ssn4Hash, balanceDays, lastResetYear, createdAt}` (`ssn4Hash` is the full bcrypt hash string, which embeds its salt) |
| `pto:decision-claim:{requestId}` | string | `"unused"`, 72h TTL — one-time-use claim for the email Approve/Deny links and admin decision |
| `pto:employees` | set | all employee IDs |
| `pto:request:{id}` | JSON string | `{id, employeeId, employeeName, startDate, endDate, days, reason, status: "pending"|"approved"|"denied", createdAt, decidedAt, decisionNote}` |
| `pto:requests` | list (capped 200) | request IDs, newest first — global ordering for admin views |
| `pto:requests:by-employee:{employeeId}` | list (capped 50) | request IDs for one employee — for the portal's history view |
| `pto:rate:login:{nameKey}` | sorted set / counter | sliding-window login attempts per name |
| `pto:rate:ip:{ip}` | sorted set / counter | sliding-window login attempts per IP |

`nameKey` = lowercased, whitespace-collapsed name (e.g. "John  Smith" → "john smith"). Stored on the employee record for direct lookup.

**Iteration order on lookup.** `pto:employees` is a Redis set (unordered). The findEmployee helper loads the set, fetches each employee record, and iterates in the order returned. If two employees share both name and last-4 SSN, the helper returns the first one whose hash verifies; the admin sees a one-time warning in the response so the duplicate can be renamed. In practice this collision is extremely rare with <20 employees.

## Authentication & security

**SSN-4 only — never the full SSN.**
- Add Employee form: `<input maxlength=4 pattern="\d{4}" inputmode="numeric">`.
- Server rejects anything not exactly 4 digits.
- Stored as a bcrypt hash. Verification uses bcrypt's constant-time compare.

**Employee sign-in**
- Stateless. Name + ssn4 sent on every API call; server re-verifies.
- Generic 401 message: never reveal whether the name or the SSN was the wrong piece.

**Rate limits on `/api/pto-public` login**
- 5 attempts per name per 15 min, then 429 for 15 min.
- 30 attempts per IP per 15 min as a secondary backstop.
- Successful sign-in clears the per-name counter.

**Admin auth**
- Existing admin password → bearer token. Reused for `/api/pto`. No second password.

**Email magic-links**
- HMAC-SHA256 over `{requestId, decision}` with `PTO_APPROVAL_SECRET`.
- One-time use enforced atomically (decision claim via Redis `getdel` or equivalent).
- Tampered token → 401; reused token → 410 "Already decided".

**No PII in logs.** Error logs include request IDs and employee IDs, not names, emails, or SSN values.

## Email flows

**On new request → owner alert:**
- Subject: "PTO request: {employeeName} — {startDate} to {endDate} ({days} d)"
- Body: name, dates, days, reason, current balance, balance after approve.
- Buttons: Approve (green), Deny (red) — both HMAC-signed magic-links to `/api/pto-decision`.

**On approve → employee notification:**
- Subject: "PTO approved: {startDate} to {endDate}"
- Body: confirms dates and new balance.

**On deny → employee notification:**
- Subject: "PTO request not approved"
- Body: dates + the owner's optional note.

**Email-send failure policy:** Decision and balance update are the source of truth — they persist in Redis even if the email send fails. Email failures are logged. The employee will see the decision in the portal regardless.

## Edge cases

| Case | Handling |
|------|----------|
| Requested days > balance | 400 with explanatory message; form retained |
| Start date > end date | Client and server both reject |
| Past dates | Server rejects (server clock is authoritative) |
| Saturday/Sunday in range | Skipped in the day count |
| US holiday in range | Counted as a workday — not in scope to maintain a holiday calendar |
| Two employees with the same name | Both load on the lookup; the one whose ssn4 hash verifies wins. If both names AND last-4 collide (extremely rare with <20 employees), the helper returns the first matching record in Redis set order, and the admin sees a warning so one can be renamed |
| Employee deleted with pending requests | Requests stay in the admin list (employeeName preserved). Owner can still Deny for cleanup; Approve is blocked — the employee record is needed for balance update |
| Jan 1 roll-over | Lazy: on first access in a new year, balance resets to 5 and `lastResetYear` updates. Self-healing if a cron is ever missed |
| Manual balance adjust mid-year | Sets balance directly; doesn't touch `lastResetYear`, so the Jan 1 reset still fires next year |
| Race: two approvals in flight | Each decision re-loads the employee, re-checks balance, and writes atomically. Cannot go negative |
| Email-send failure | Decision persists in Redis; email failure logged |
| Resend not configured | Same as above — decisions saved, owner alert and employee notification both fail to send; portal still works |

## Testing

**Unit tests** (Node built-in `node:test`):
- `hashSsn4` / `verifySsn4` — round-trip; wrong digits rejected; different salts produce different hashes for same input; constant-time comparison.
- `countWeekdays` — same day = 1, full Mon–Fri = 5, Mon–following Mon = 6, end < start throws, weekend-only range = 0.
- `lazyResetBalance(employee, currentYear)` — same year passes through, new year resets to 5 and updates `lastResetYear`.
- Rate-limiter — 5 attempts allowed, 6th blocked, counter clears after window, successful sign-in resets counter.
- HMAC token sign/verify — round-trip, forged sig rejected, tampered payload rejected, wrong action rejected.
- `findEmployee` — exact match, case-/whitespace-normalized, wrong ssn4 returns null even when name matches, same-name collision picks the one whose ssn4 verifies.

**Endpoint tests** (in-memory Redis mock, same pattern as the FB agent's themes test):
- `pto-public` login — valid returns balance + history; bad name returns 401; bad ssn4 returns 401 same wording; rate-limit triggers after 5 attempts.
- `pto-public` request — rejects when days > balance, end < start, empty reason; valid request creates `pending`, mocked email sent, balance NOT decremented.
- `pto` admin — bearer required; CRUD round-trips; approve decrements balance and (mocked) emails employee; deny doesn't change balance.
- `pto-decision` magic-link — valid decides once; reused → 410; forged → 401.

**Manual go-live procedure:**
1. Set `PTO_APPROVAL_SECRET` in Vercel (`openssl rand -base64 32`).
2. Deploy. Open `/pto-admin.html`, log in, add a test employee — your own name, your own email, last-4 = `0000`.
3. Open `/pto.html` in another tab; sign in as the test employee.
4. Submit a small request (e.g. 1 day next week). Confirm the alert email arrives in your inbox.
5. Click Approve in the email; confirm the success page + approval email lands.
6. Submit a second request; this time click Deny in the email with a note; confirm denial email.
7. Confirm balance went from 5 → 4 → still 4 (deny doesn't decrement).
8. Delete the test employee.

**Not automated:** real email delivery (covered by the manual step), the cross-tab admin↔employee flow (manual).

## Open questions resolved during brainstorming

1. Approval flow → owner approves each request (not auto-approve).
2. SSN storage → last 4 only, hashed (`bcryptjs`).
3. Employee identification → name + last-4 SSN as a single sign-in gate; protects balance from name-only lookup.
4. Request granularity → full days, date range (start + end, weekdays-only count).
5. Notifications → owner alerted on new request; employee notified on decision.
6. Where it lives → employee at `/pto.html`, admin at separate `/pto-admin.html` (not a tab in invoice admin).
7. Admin auth → reuses existing admin password.
8. New-hire balance → full 5 days on add; lazy reset to 5 on Jan 1; admin can adjust manually.
9. Half days → not in v1.
10. US holidays → not in v1.

## Implementation order (preview for the plan)

1. `bcryptjs` dependency + `api/_lib/pto-auth.js` hash/verify helpers + unit tests.
2. `api/_lib/pto-dates.js` `countWeekdays` + unit tests.
3. `api/_lib/pto-rate-limit.js` sliding-window counter + unit tests.
4. `api/_lib/pto-tokens.js` HMAC sign/verify + unit tests.
5. `api/_lib/pto-email.js` Resend templates + wrappers.
6. `api/pto.js` admin endpoint (CRUD + decide) with mocked Redis tests.
7. `api/pto-public.js` employee endpoint (login + request) with tests.
8. `api/pto-decision.js` magic-link endpoint with tests.
9. `/pto.html` employee portal — sign-in + portal + request form + history.
10. `/pto-admin.html` admin page — login + pending requests + employees CRUD.
11. Set `PTO_APPROVAL_SECRET` in Vercel; deploy; manual end-to-end test.
