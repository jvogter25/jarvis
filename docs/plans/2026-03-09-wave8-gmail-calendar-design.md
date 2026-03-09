# Wave 8: Gmail + Calendar Integration Design

## Goal

Jarvis sends email outreach on Jake's behalf, monitors the Jarvis Gmail inbox for replies, and has Calendar awareness — all from a dedicated `jarvis.ops@gmail.com` account. Jake's writing style is ingested once from a bulk email export and refined over time via `#training`.

## Architecture

### Auth

**Google Cloud OAuth2 via `googleapis` npm package.** Single set of credentials covers Gmail API + Calendar API. Jake runs a one-time local auth script (`scripts/gmail-auth.mjs`) that opens a browser, he logs in as the Jarvis Gmail account, and the script prints the refresh token. Three env vars stored in Railway: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Jarvis handles token refresh automatically on every request — no manual re-auth.

### Style Ingestion (one-time)

Jake exports his Gmail Sent folder via Google Takeout (`.mbox` format). A local script (`scripts/ingest-email-style.mjs`) parses the `.mbox`, strips quoted replies and signatures, batches emails in groups of 20, sends each batch to Claude to extract writing patterns (sentence structure, openers, closers, how Jake makes asks, formality, phrases to avoid). Stores result as a single `knowledge_base` entry with `domain = 'email_style'`. Jarvis pulls this profile automatically via `search_knowledge` before composing any email.

Ongoing style corrections: Jake posts to `#training` tagged `style: [note]` — same channel already built.

### Gmail Tool (`src/tools/gmail.ts`)

New file wrapping `googleapis`. Exports:
- `sendEmail(to, subject, body)` — sends from Jarvis Gmail account
- `readInbox(limit?)` — fetches unread threads
- `searchThreads(query)` — Gmail search query syntax
- `readThread(threadId)` — full thread content
- `draftEmail(to, subject, body)` — saves to Drafts (for review before send)
- `getUpcomingEvents(days?)` — Calendar events for next N days
- `createCalendarEvent(title, start, end, description?)` — creates event

### Brain Tools

Three new tools in `brain.ts`:

| Tool | Description | Always available? |
|---|---|---|
| `draft_email` | Compose an email — Jarvis shows draft in Discord, Jake approves before send | Yes |
| `send_email` | Execute a send after approval | Yes |
| `check_inbox` | Scan inbox for important unread threads, surface to Discord | Yes |

`draft_email` always calls `search_knowledge('email_style', context)` before composing. Output posted to Discord for Jake's approval. Jake says "send it" → `send_email` executes. Same approval gate pattern as staging deploys.

### Inbox Monitor Cron

Every 30 minutes: `readInbox()` → score each thread (is it a reply to Jarvis-sent outreach? does it require a response?). High-priority threads surface to `#jarvis` with a summary and a draft reply for Jake to approve or edit. Newsletters, auto-replies, noise → ignored.

Scoring logic: threads where Jarvis was the last sender + reply received = always surface. Unknown senders + no prior context = ignore unless subject/content signals urgency.

### Calendar

`get_calendar_events` and `create_calendar_event` tools. Jarvis checks calendar before suggesting meeting times in any email. Jake approves all event creation — no auto-scheduling.

### Approval Gate in `handlers.ts`

New `pendingEmailApproval` map (same pattern as `pendingPreviewApproval`). Jarvis posts draft → Jake says "send it" → `sendEmail()` executes. Negative reply cancels. Conversational reply falls through without clearing state.

## Files Changed

| File | Change |
|---|---|
| `scripts/gmail-auth.mjs` | One-time OAuth flow — prints refresh token |
| `scripts/ingest-email-style.mjs` | Parses .mbox, extracts style, stores in knowledge_base |
| `src/tools/gmail.ts` | Gmail + Calendar API wrapper |
| `src/brain.ts` | Add `draft_email`, `send_email`, `check_inbox` tool schemas + executors |
| `src/discord/handlers.ts` | Add `pendingEmailApproval` map + approval check block |
| `src/overnight/briefing.ts` | Add inbox check to morning brief (surface overnight replies) |
| `src/index.ts` | Add 30-min inbox monitor cron |
| `src/tools/registry.ts` | Register new tools |

## Key Constraints

- Gmail API daily sending limit: 500 emails/day (plenty for current scale)
- OAuth refresh token never expires as long as it's used at least once every 6 months
- `googleapis` package handles token refresh automatically — no manual re-auth
- Jake must create Google Cloud project + enable Gmail API + Calendar API + create OAuth2 credentials before auth script can run
- All email sends require Jake approval — hard gate, same as production deploys
- Calendar event creation requires Jake approval — no auto-scheduling ever
- Jarvis Gmail account is completely separate from Jake's personal/work accounts — hard boundary

## New Railway Env Vars

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

## Setup Order (before Wave 8 deploys)

1. Create dedicated Gmail account (`jarvis.ops@gmail.com` or similar)
2. Create Google Cloud project → enable Gmail API + Google Calendar API
3. Create OAuth2 credentials (Web application type, redirect URI: `http://localhost:3000/oauth/callback`)
4. Run `scripts/gmail-auth.mjs` locally → copy refresh token into Railway
5. Export Sent folder via Google Takeout → run `scripts/ingest-email-style.mjs`
