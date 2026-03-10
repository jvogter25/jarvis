# Wave 8: Gmail + Calendar Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Jarvis sends email outreach on Jake's behalf, monitors the Jarvis Gmail inbox, and has Calendar awareness — all from a dedicated Jarvis Gmail account with Jake approving all sends.

**Architecture:** `googleapis` npm package with OAuth2 refresh token stored in Railway env vars. One-time local scripts for auth setup and email style ingestion. Gmail tool wraps send/read/calendar. draft_email tool posts to Discord for approval before any send.

**Tech Stack:** googleapis (Gmail API + Calendar API), @supabase/supabase-js (style storage), node-cron (inbox monitor), discord.js (approval gate)

---

## Prerequisites (Jake does these manually before running any task)

1. Create a dedicated Gmail account for Jarvis (e.g. `jarvis.ops@gmail.com`)
2. Go to [console.cloud.google.com](https://console.cloud.google.com) → New Project
3. Enable **Gmail API** and **Google Calendar API** on the project
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:3000/oauth/callback`
5. Download the credentials — note `Client ID` and `Client Secret`
6. Add to `.env` locally: `GMAIL_CLIENT_ID=...` and `GMAIL_CLIENT_SECRET=...`
7. Run Task 1 (auth script) to get `GMAIL_REFRESH_TOKEN`
8. Add all three vars to Railway env vars before deploying

---

## Task 1 — Gmail auth script (`scripts/gmail-auth.mjs`)

**File:** `scripts/gmail-auth.mjs`

**What it does:** Runs locally (not on Railway). Opens OAuth2 flow in a browser, Jake logs in as the Jarvis Gmail account, and the script prints `GMAIL_REFRESH_TOKEN=<token>` to the terminal.

```javascript
// scripts/gmail-auth.mjs
import 'dotenv/config';
import http from 'http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force consent screen so refresh_token is always returned
});

console.log('\nOpen this URL in your browser (logged in as the Jarvis Gmail account):\n');
console.log(authUrl);
console.log('\nWaiting for redirect...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Auth failed</h1><p>' + error + '</p>');
    console.error('\nAuth error:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No code received');
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Success!</h1><p>You can close this tab. Check your terminal.</p>');

    console.log('\nSuccess! Add this to Railway env vars:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nAlso confirm in .env for local use.');
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed');
    console.error('\nToken exchange failed:', err);
  }

  server.close();
});

server.listen(3000, () => {
  console.log('Listening on http://localhost:3000 ...');
});
```

**Install dependency:**
```bash
npm install googleapis
```

**Run locally:**
```bash
node scripts/gmail-auth.mjs
# Open the printed URL in browser, log in as Jarvis Gmail account
# Copy GMAIL_REFRESH_TOKEN from terminal output into Railway + .env
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add scripts/gmail-auth.mjs package.json package-lock.json
git commit -m "feat: add Gmail OAuth2 auth script (wave 8)"
```

---

## Task 2 — Gmail tool (`src/tools/gmail.ts`)

**File:** `src/tools/gmail.ts`

**What it does:** Wraps `googleapis` for Gmail send/read and Calendar read/create. All functions are async and throw on error — callers handle errors via try/catch.

```typescript
// src/tools/gmail.ts
import { google } from 'googleapis';

function getGmailAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return auth;
}

export interface EmailThread {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  isReply: boolean; // true if thread has >1 message (we sent, they replied back)
}

/**
 * Send an email from the Jarvis Gmail account.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

/**
 * Read unread inbox threads. Returns structured thread summaries.
 */
export async function readInbox(limit = 10): Promise<EmailThread[]> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX', 'UNREAD'],
    maxResults: limit,
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) return [];

  const threads: EmailThread[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });

      const headers = msgRes.data.payload?.headers ?? [];
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
      const threadId = msgRes.data.threadId ?? msg.id;
      const snippet = msgRes.data.snippet ?? '';

      // Check if this is a reply (thread has more than 1 message)
      const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'minimal',
      });
      const messageCount = threadRes.data.messages?.length ?? 1;

      threads.push({
        threadId,
        subject,
        from,
        snippet,
        isReply: messageCount > 1,
      });
    } catch (err) {
      console.error(`[gmail] Failed to fetch message ${msg.id}:`, err);
    }
  }

  return threads;
}

/**
 * Read a full thread and return formatted text for Claude context.
 */
export async function readThread(threadId: string): Promise<string> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const threadRes = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });

  const messages = threadRes.data.messages ?? [];
  const parts: string[] = [];

  for (const msg of messages) {
    const headers = msg.payload?.headers ?? [];
    const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
    const date = headers.find(h => h.name === 'Date')?.value ?? '';
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';

    // Extract plain text body
    let body = '';
    const findTextPart = (payload: typeof msg.payload): string => {
      if (!payload) return '';
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
      }
      if (payload.parts) {
        for (const part of payload.parts) {
          const text = findTextPart(part);
          if (text) return text;
        }
      }
      return '';
    };

    body = findTextPart(msg.payload);

    parts.push(`From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.trim()}`);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Get upcoming calendar events for the next N days.
 * Returns formatted event list as a string for Claude context.
 */
export async function getUpcomingEvents(days = 7): Promise<string> {
  const auth = getGmailAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return `No events in the next ${days} days.`;

  return events.map(e => {
    const start = e.start?.dateTime ?? e.start?.date ?? 'unknown';
    const end = e.end?.dateTime ?? e.end?.date ?? '';
    const title = e.summary ?? '(untitled)';
    const location = e.location ? ` @ ${e.location}` : '';
    return `• ${title}${location}\n  ${start}${end ? ' → ' + end : ''}`;
  }).join('\n\n');
}

/**
 * Create a calendar event. Returns the HTML link to the created event.
 */
export async function createCalendarEvent(
  title: string,
  startIso: string,
  endIso: string,
  description?: string
): Promise<string> {
  const auth = getGmailAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
    },
  });

  return res.data.htmlLink ?? 'Event created (no link returned)';
}
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/tools/gmail.ts
git commit -m "feat: add Gmail + Calendar API wrapper (wave 8)"
```

---

## Task 3 — Email style ingestion script (`scripts/ingest-email-style.mjs`)

**File:** `scripts/ingest-email-style.mjs`

**What it does:** Runs locally (not on Railway). Parses a `.mbox` file exported from Gmail Takeout, batches emails into groups of 15, calls Claude (haiku) per batch to extract writing patterns, then synthesizes a unified style profile and saves it to the Supabase `knowledge_base` table with `domain = 'email_style'`.

**How Jake gets the .mbox file:**
- Go to [takeout.google.com](https://takeout.google.com)
- Select only **Gmail** → deselect everything else
- Under Gmail, choose **Sent Mail** only
- Download the export, extract the `.mbox` file

**Run:**
```bash
node scripts/ingest-email-style.mjs ~/Downloads/Sent.mbox
```

```javascript
// scripts/ingest-email-style.mjs
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// --- Args ---
const mboxPath = process.argv[2];
if (!mboxPath) {
  console.error('Usage: node scripts/ingest-email-style.mjs <path-to-Sent.mbox>');
  process.exit(1);
}

const resolvedPath = path.resolve(mboxPath.replace(/^~/, process.env.HOME ?? ''));
if (!fs.existsSync(resolvedPath)) {
  console.error(`File not found: ${resolvedPath}`);
  process.exit(1);
}

// --- Clients ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_ANON_KEY
);

// --- Parse .mbox ---
console.log('Reading .mbox file...');
const raw = fs.readFileSync(resolvedPath, 'utf-8');

// Split on "From " lines that start a new message (mbox format)
const chunks = raw.split(/^From /m).filter(c => c.trim().length > 0);
console.log(`Found ${chunks.length} raw messages`);

function extractEmail(chunk) {
  const lines = chunk.split('\n');
  let subject = '';
  let inBody = false;
  const bodyLines = [];

  for (const line of lines) {
    if (!inBody) {
      if (line.toLowerCase().startsWith('subject:')) {
        subject = line.replace(/^subject:\s*/i, '').trim();
      }
      // Empty line separates headers from body
      if (line.trim() === '') {
        inBody = true;
      }
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join('\n').trim();

  // Skip if body is too short (auto-replies, empty acks)
  if (body.length < 50) return null;
  // Skip if it looks like a forwarded message only
  if (body.startsWith('---------- Forwarded message')) return null;

  return { subject, body: body.slice(0, 2000) };
}

const emails = chunks
  .map(extractEmail)
  .filter(Boolean)
  .slice(0, 200); // cap at 200 emails

console.log(`Extracted ${emails.length} usable emails (after filtering)`);

if (emails.length === 0) {
  console.error('No usable emails found. Check the .mbox format.');
  process.exit(1);
}

// --- Batch Claude calls ---
const BATCH_SIZE = 15;
const batches = [];
for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  batches.push(emails.slice(i, i + BATCH_SIZE));
}

console.log(`Processing ${batches.length} batch(es) with haiku...`);

async function extractBatchStyle(batch, batchIndex) {
  const emailText = batch.map((e, i) =>
    `--- Email ${i + 1} ---\nSubject: ${e.subject}\n\n${e.body}`
  ).join('\n\n');

  const prompt = `You are analyzing a set of emails written by the same person (Jake) to extract their writing style.

Emails to analyze:
${emailText.slice(0, 12000)}

Extract specific, actionable style patterns. Return JSON only, no markdown:
{
  "sentence_length": "short/medium/long and why",
  "openers": ["typical opening phrases or patterns"],
  "closers": ["typical closing phrases or sign-offs"],
  "ask_style": "how they make requests or calls to action",
  "formality": "casual/semi-formal/formal",
  "phrases_used": ["phrases or words they commonly use"],
  "phrases_avoided": ["formal/corporate phrases they do not use"],
  "tone_notes": "overall tone description in 2 sentences"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are extracting email writing style patterns. Return only valid JSON.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`Batch ${batchIndex + 1}: failed to parse JSON, skipping`);
    return null;
  }
}

const batchResults = [];
for (let i = 0; i < batches.length; i++) {
  process.stdout.write(`  Batch ${i + 1}/${batches.length}... `);
  const result = await extractBatchStyle(batches[i], i);
  if (result) {
    batchResults.push(result);
    console.log('done');
  } else {
    console.log('skipped (parse error)');
  }
}

if (batchResults.length === 0) {
  console.error('All batches failed. Cannot synthesize style profile.');
  process.exit(1);
}

// --- Synthesize unified style profile ---
console.log('\nSynthesizing unified style profile with sonnet...');

const synthesisPrompt = `You are synthesizing ${batchResults.length} partial email style analyses from the same writer (Jake) into one unified, authoritative style guide.

Batch analyses:
${JSON.stringify(batchResults, null, 2).slice(0, 10000)}

Synthesize these into a single, unified style profile. Resolve any contradictions by going with the majority pattern. Return JSON only, no markdown:
{
  "summary": "2-3 sentence description of Jake's overall email writing voice",
  "sentence_length": "short/medium/long + explanation",
  "openers": ["5-8 typical opening patterns"],
  "closers": ["3-5 typical closing patterns"],
  "ask_style": "how to phrase requests and calls-to-action",
  "formality": "casual/semi-formal/formal",
  "phrases_to_use": ["10-15 phrases or words Jake commonly uses"],
  "phrases_to_avoid": ["10-15 formal/corporate phrases Jake avoids"],
  "tone_notes": "specific guidance for writing in Jake's voice",
  "example_opener": "example of a strong opening sentence in Jake's voice",
  "example_ask": "example of how Jake would make a clear ask"
}`;

const synthesisResponse = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 2048,
  system: 'You are synthesizing writing style patterns into a unified guide. Return only valid JSON.',
  messages: [{ role: 'user', content: synthesisPrompt }],
});

const synthesisText = synthesisResponse.content.find(b => b.type === 'text')?.text ?? '{}';
let styleProfile;
try {
  styleProfile = JSON.parse(synthesisText);
} catch {
  console.error('Synthesis parse failed. Raw output:\n', synthesisText.slice(0, 500));
  process.exit(1);
}

// --- Save to Supabase knowledge_base ---
console.log('\nSaving to Supabase knowledge_base...');

const { error } = await supabase
  .from('knowledge_base')
  .upsert({
    domain: 'email_style',
    title: 'Jake email writing style',
    content: JSON.stringify(styleProfile, null, 2),
    key_insights: [
      styleProfile.summary ?? '',
      `Formality: ${styleProfile.formality}`,
      `Ask style: ${styleProfile.ask_style}`,
      `Tone: ${styleProfile.tone_notes}`,
    ].filter(Boolean),
    source_url: null,
  }, {
    onConflict: 'domain,title',
  });

if (error) {
  console.error('Supabase upsert failed:', error);
  process.exit(1);
}

console.log('\nDone! Email style profile saved to knowledge_base.');
console.log('\nStyle summary:', styleProfile.summary);
console.log('\nRun `node scripts/ingest-email-style.mjs` again after exporting more emails to refine the profile.');
```

**Verification:**
```bash
npx tsc --noEmit
```
(This script is `.mjs` and not part of the TypeScript compilation — TSC check is for the main project only.)

**Git commit:**
```bash
git add scripts/ingest-email-style.mjs
git commit -m "feat: add email style ingestion script from .mbox (wave 8)"
```

---

## Task 4 — Brain tools (`src/brain.ts`)

**File:** `src/brain.ts`

**What changes:**
1. Add `emailDraftResult` field to `ToolCallResult` interface
2. Add `draft_email`, `send_email`, `check_inbox` schemas to `TOOL_SCHEMAS`
3. Add `draft_email`, `send_email`, `check_inbox` cases to `executeTool()`
4. Add all three to the `alwaysAvailable` array

### 4a. Add to `ToolCallResult` interface

Find this block (around line 201):
```typescript
export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
  selfModifyProposal?: { plan: import('./tools/self-modify.js').SelfModifyPlan; message: string };
  createProjectResult?: { slug: string; generalChannelId: string; githubRepo: string };
  previewResult?: {
    slug: string;
    previewUrl: string;
    sandboxId: string;
    files: Array<{ path: string; content: string }>;
    plan: import('./tools/builder.js').BuildPlan;
  };
}
```

Add one field at the end, before the closing `}`:
```typescript
  emailDraftResult?: { to: string; subject: string; body: string };
```

Full updated interface:
```typescript
export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
  selfModifyProposal?: { plan: import('./tools/self-modify.js').SelfModifyPlan; message: string };
  createProjectResult?: { slug: string; generalChannelId: string; githubRepo: string };
  previewResult?: {
    slug: string;
    previewUrl: string;
    sandboxId: string;
    files: Array<{ path: string; content: string }>;
    plan: import('./tools/builder.js').BuildPlan;
  };
  emailDraftResult?: { to: string; subject: string; body: string };
}
```

### 4b. Add tool schemas to `TOOL_SCHEMAS`

After the `create_project` schema entry (before the closing `}`), add:

```typescript
  draft_email: {
    name: 'draft_email',
    description: 'Compose an email on Jake\'s behalf. Pulls Jake\'s writing style from the knowledge base, writes the email in his voice, and posts it to Discord for approval before any send. Jake says "send it" to trigger the actual send.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body — write this in Jake\'s voice using the style guide' },
        context: { type: 'string', description: 'What this email is for — used to pull the most relevant style guidance' },
      },
      required: ['to', 'subject', 'body', 'context'],
    },
  },
  send_email: {
    name: 'send_email',
    description: 'Send an email from the Jarvis Gmail account. Only call this after Jake has approved a draft via the Discord approval gate. Do not call this directly without prior draft_email approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  check_inbox: {
    name: 'check_inbox',
    description: 'Check the Jarvis Gmail inbox for unread messages. Returns a summary of unread threads — who sent them, subject, and whether they are replies to emails Jarvis sent. Use when Jake asks to check email or when the inbox monitor surfaces something.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
```

### 4c. Add executor cases to `executeTool()`

After the `create_project` case and before the `default` case, add:

```typescript
    case 'draft_email': {
      const { queryKnowledge } = await import('./tools/knowledge.js');
      const to = input.to as string;
      const subject = input.subject as string;
      const body = input.body as string;
      const context = input.context as string;

      // Pull Jake's email style from knowledge base
      const styleGuide = await queryKnowledge('email_style', context);

      const preview =
        `**To:** ${to}\n**Subject:** ${subject}\n\n${body}\n\n---\n*Style guide applied:* ${styleGuide.slice(0, 200)}`;

      return {
        toolName: name,
        output: preview,
        emailDraftResult: { to, subject, body },
      };
    }

    case 'send_email': {
      const { sendEmail } = await import('./tools/gmail.js');
      const to = input.to as string;
      const subject = input.subject as string;
      const body = input.body as string;
      try {
        await sendEmail(to, subject, body);
        return { toolName: name, output: `Sent to ${to}.` };
      } catch (err) {
        return { toolName: name, output: `Send failed: ${(err as Error).message}` };
      }
    }

    case 'check_inbox': {
      const { readInbox } = await import('./tools/gmail.js');
      try {
        const threads = await readInbox(20);
        if (threads.length === 0) {
          return { toolName: name, output: 'Inbox is clear — no unread messages.' };
        }
        const formatted = threads.map(t =>
          `• **${t.subject}**\n  From: ${t.from}\n  ${t.snippet.slice(0, 100)}${t.isReply ? ' *(reply)*' : ''}`
        ).join('\n\n');
        return { toolName: name, output: `${threads.length} unread thread(s):\n\n${formatted}` };
      } catch (err) {
        return { toolName: name, output: `Inbox check failed: ${(err as Error).message}` };
      }
    }
```

### 4d. Add to `alwaysAvailable` array

Find this line:
```typescript
const alwaysAvailable = ['self_modify_request', 'search_knowledge', 'create_project'];
```

Replace with:
```typescript
const alwaysAvailable = ['self_modify_request', 'search_knowledge', 'create_project', 'draft_email', 'send_email', 'check_inbox'];
```

And add the three new schemas to the always-available spread block:
```typescript
return [
  TOOL_SCHEMAS.self_modify_request,
  TOOL_SCHEMAS.search_knowledge,
  TOOL_SCHEMAS.create_project,
  TOOL_SCHEMAS.draft_email,
  TOOL_SCHEMAS.send_email,
  TOOL_SCHEMAS.check_inbox,
  ...Object.values(TOOL_SCHEMAS).filter(
    t => !alwaysAvailable.includes(t.name) && installedToolIds.has(t.name)
  ),
];
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/brain.ts
git commit -m "feat: add draft_email, send_email, check_inbox brain tools (wave 8)"
```

---

## Task 5 — Email approval gate (`src/discord/handlers.ts`)

**File:** `src/discord/handlers.ts`

**What changes:**
1. Add `pendingEmailApproval` map at the top of the module (alongside the other pending maps)
2. Add approval check block for email sends in `handleMessage()` (after the `pendingPreviewApproval` block)
3. Add `emailDraftResult` handler in the tool results loop

### 5a. Add import and `pendingEmailApproval` map

After the existing imports, add the `sendEmail` import inline (dynamic import pattern used everywhere):
No static import needed — use dynamic `import('./tools/gmail.js')` inside the handler, consistent with other tools.

After the `pendingPreviewApproval` map declaration (around line 50), add:

```typescript
const pendingEmailApproval = new Map<string, {
  to: string;
  subject: string;
  body: string;
}>();
```

### 5b. Add approval check block in `handleMessage()`

After the `pendingPreviewApproval` check block (after the closing `}` of that block, before the overnight mode lines), add:

```typescript
  // Check if we're waiting for email send approval
  const pendingEmail = pendingEmailApproval.get(msg.channelId);
  if (pendingEmail) {
    if (msg.content.toLowerCase().trim() === 'send it' || isShipApproval(msg.content)) {
      pendingEmailApproval.delete(msg.channelId);
      await msg.channel.send(`Sending email to **${pendingEmail.to}**...`);
      try {
        const { sendEmail } = await import('../tools/gmail.js');
        await sendEmail(pendingEmail.to, pendingEmail.subject, pendingEmail.body);
        await msg.channel.send(`Email sent to **${pendingEmail.to}**.`);
      } catch (err) {
        await msg.channel.send(`Failed to send: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingEmailApproval.delete(msg.channelId);
      await msg.channel.send(`Email cancelled. Let me know if you want to revise it.`);
      return;
    }
    // Conversational reply — fall through with pending preserved so Jake can edit the draft
  }
```

### 5c. Add `emailDraftResult` handler in the tool results loop

In the tool results loop (inside `for (const toolResult of result.toolResults)`), after the `previewResult` handler block, add:

```typescript
      if (toolResult.emailDraftResult) {
        const draft = toolResult.emailDraftResult;
        pendingEmailApproval.set(msg.channelId, draft);
        const draftMsg =
          `📧 Draft ready — send to **${draft.to}**?\n\n` +
          `**Subject:** ${draft.subject}\n\n` +
          `${draft.body}\n\n` +
          `Say **"send it"** to send, or tell me what to change.`;
        await msg.channel.send(draftMsg);
      }
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/discord/handlers.ts
git commit -m "feat: add email approval gate to Discord handlers (wave 8)"
```

---

## Task 6 — Inbox monitor (`src/overnight/inbox-monitor.ts`)

**File:** `src/overnight/inbox-monitor.ts` (new file)

**What it does:** Runs every 30 minutes. Reads unread inbox, filters for threads where Jarvis sent and received a reply (high-signal). Skips noise (newsletters, auto-replies). For reply threads, reads the full thread, scores with haiku (needs response? yes/no), then drafts a reply with sonnet in Jake's voice. Posts to `#jarvis` for approval.

```typescript
// src/overnight/inbox-monitor.ts
import { Client, TextChannel } from 'discord.js';
import { readInbox, readThread } from '../tools/gmail.js';
import { think } from '../brain.js';
import { queryKnowledge } from '../tools/knowledge.js';
import { CHANNELS } from '../discord/channels.js';

// Senders to always ignore — newsletters, marketing, auto-replies
const NOISE_PATTERNS = [
  /no.?reply/i,
  /noreply/i,
  /newsletter/i,
  /unsubscribe/i,
  /notifications?@/i,
  /mailer.daemon/i,
  /postmaster/i,
  /bounce/i,
  /donotreply/i,
];

function isNoiseSender(from: string): boolean {
  return NOISE_PATTERNS.some(p => p.test(from));
}

export async function runInboxMonitor(discord: Client): Promise<void> {
  console.log('[inbox-monitor] Running...');

  let threads;
  try {
    threads = await readInbox(20);
  } catch (err) {
    console.error('[inbox-monitor] Failed to read inbox:', err);
    return;
  }

  if (threads.length === 0) {
    console.log('[inbox-monitor] No unread threads.');
    return;
  }

  // Filter: only reply threads (we sent, they responded back) and not noise
  const replyThreads = threads.filter(t => t.isReply && !isNoiseSender(t.from));

  if (replyThreads.length === 0) {
    console.log('[inbox-monitor] No reply threads requiring attention.');
    return;
  }

  console.log(`[inbox-monitor] ${replyThreads.length} reply thread(s) to evaluate`);

  const channel = discord.channels.cache.get(CHANNELS.JARVIS) as TextChannel | undefined;
  if (!channel) {
    console.error('[inbox-monitor] JARVIS channel not found');
    return;
  }

  // Pull Jake's email style once for the whole run
  let styleGuide = '';
  try {
    styleGuide = await queryKnowledge('email_style', 'replying to an email conversation');
  } catch {
    console.warn('[inbox-monitor] Could not load email style guide — proceeding without it');
  }

  for (const thread of replyThreads) {
    try {
      // Read full thread context
      const threadText = await readThread(thread.threadId);

      // Score: does this need a response?
      const scoreResult = await think(
        'You are evaluating whether an email thread requires a response. Be conservative — only flag threads that genuinely need a reply (business conversations, active discussions, direct questions). Newsletters, marketing, and passive updates do not need replies.',
        [],
        `Thread:\n${threadText.slice(0, 3000)}\n\nDoes this thread need a response from Jake? Return JSON only:\n{"needs_response": true/false, "reason": "one sentence explanation"}`,
        { model: 'haiku', noTools: true }
      );

      let needsResponse = false;
      let reason = '';
      try {
        const scored = JSON.parse(scoreResult.text);
        needsResponse = scored.needs_response === true;
        reason = scored.reason ?? '';
      } catch {
        console.warn(`[inbox-monitor] Score parse failed for thread ${thread.threadId}`);
        continue;
      }

      if (!needsResponse) {
        console.log(`[inbox-monitor] Skipping "${thread.subject}" — ${reason}`);
        continue;
      }

      // Draft a reply in Jake's voice
      const draftResult = await think(
        `You are Jarvis drafting an email reply on Jake's behalf. Write in Jake's voice — direct, friendly, no corporate fluff. Use the style guide provided.${styleGuide ? '\n\nStyle guide:\n' + styleGuide : ''}`,
        [],
        `Thread to reply to:\n${threadText.slice(0, 4000)}\n\nDraft a reply from Jake. Return only the email body — no subject line, no "To:", just the body text.`,
        { model: 'sonnet', noTools: true }
      );

      const draftBody = draftResult.text.trim();

      // Post to #jarvis for approval
      const msg =
        `📧 **Reply needed** — "${thread.subject}"\n` +
        `From: ${thread.from}\n\n` +
        `**Drafted reply:**\n\n${draftBody}\n\n` +
        `Say **"send it"** to send this reply to ${thread.from}, or tell me what to change.\n` +
        `*(Thread ID: ${thread.threadId})*`;

      // Split message if too long (Discord 2000 char limit)
      if (msg.length <= 2000) {
        await channel.send(msg);
      } else {
        const header = `📧 **Reply needed** — "${thread.subject}"\nFrom: ${thread.from}\n\n**Drafted reply:**`;
        await channel.send(header);
        await channel.send(draftBody.slice(0, 1800));
        await channel.send(`Say **"send it"** to send to ${thread.from}, or tell me what to change.\n*(Thread ID: ${thread.threadId})*`);
      }

      console.log(`[inbox-monitor] Surfaced reply thread: "${thread.subject}"`);
    } catch (err) {
      console.error(`[inbox-monitor] Error processing thread ${thread.threadId}:`, err);
    }
  }

  console.log('[inbox-monitor] Done.');
}
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/overnight/inbox-monitor.ts
git commit -m "feat: add inbox monitor with reply scoring and draft generation (wave 8)"
```

---

## Task 7 — Cron wiring + registry (`src/index.ts` + `src/tools/registry.ts`)

### 7a. `src/index.ts` — add inbox monitor cron

Add import at the top alongside other overnight imports:
```typescript
import { runInboxMonitor } from './overnight/inbox-monitor.js';
```

Inside `main()`, after the existing cron schedules, add:
```typescript
  // Inbox monitor: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runInboxMonitor(discord).catch(console.error);
  });
```

Full updated `main()` for reference:
```typescript
async function main() {
  console.log('Jarvis starting...');
  try { console.log('APP contents:', fs.readdirSync('/app').join(', ')); } catch {}
  console.log('CWD:', process.cwd());

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  // Research loop: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    runResearchLoop(discord).catch(console.error);
  });

  // Overnight training: 2am
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
    postProjectOvernightLogs(discord).catch(console.error);
  });

  // Morning briefing: 7am
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
    postProjectMorningBriefings(discord).catch(console.error);
  });

  // Weekly product pulse: Mondays at 8am
  cron.schedule('0 8 * * 1', () => {
    runProductPulse(discord).catch(console.error);
  });

  // Weekly tool discovery: Fridays at 9am
  cron.schedule('0 9 * * 5', () => {
    runToolDiscovery(discord).catch(console.error);
  });

  // Inbox monitor: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runInboxMonitor(discord).catch(console.error);
  });

  console.log('Jarvis online.');
}
```

### 7b. `src/tools/registry.ts` — add tool entries

After the `create_project` entry (before the closing `]`), add:

```typescript
  {
    id: 'draft_email',
    name: 'Draft Email',
    description: 'Compose an email in Jake\'s voice, post to Discord for approval before any send',
    installed: true,
    requiresEnv: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  },
  {
    id: 'send_email',
    name: 'Send Email',
    description: 'Send an email from the Jarvis Gmail account (called after approval gate)',
    installed: true,
    requiresEnv: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  },
  {
    id: 'check_inbox',
    name: 'Check Inbox',
    description: 'Read unread Gmail inbox threads and surface replies to Discord',
    installed: true,
    requiresEnv: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  },
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/index.ts src/tools/registry.ts
git commit -m "feat: wire inbox monitor cron and register Gmail tools (wave 8)"
```

---

## Task 8 — Morning brief inbox summary (`src/overnight/briefing.ts`)

**File:** `src/overnight/briefing.ts`

**What changes:** `postMorningBriefing()` calls `readInbox()` and adds an overnight email summary section to the morning brief if there are any unread reply threads.

Add import at the top:
```typescript
import { readInbox } from '../tools/gmail.js';
```

Inside `postMorningBriefing()`, after building `context` and before the `think()` call, add inbox data to context:

```typescript
  // Fetch inbox data for morning brief (non-fatal if Gmail not configured)
  let inboxSummary = '';
  try {
    const threads = await readInbox(10);
    const replyThreads = threads.filter(t => t.isReply);
    if (replyThreads.length > 0) {
      inboxSummary = `\n\nOvernight email replies (${replyThreads.length}):\n` +
        replyThreads.map(t => `- "${t.subject}" from ${t.from}`).join('\n');
    } else if (threads.length > 0) {
      inboxSummary = `\n\nInbox: ${threads.length} unread (no replies needing action)`;
    }
  } catch {
    // Gmail not configured or API error — skip silently
  }
```

Then append `inboxSummary` to the `context` string before it is passed to `think()`:

The updated `context` build:
```typescript
  const context = `
Recent conversations (last 50):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000)}

Top unreviewed opportunities:
${opportunities.slice(0, 3).map(o => `- [${o.score}/100] ${o.title}: ${o.summary}`).join('\n') || 'None yet'}
${inboxSummary}
`;
```

Full updated `postMorningBriefing()` function:
```typescript
export async function postMorningBriefing(discord: Client) {
  console.log('Morning briefing: generating...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 50);
  const opportunities = await getUnpostedOpportunities();

  // Fetch inbox data for morning brief (non-fatal if Gmail not configured)
  let inboxSummary = '';
  try {
    const threads = await readInbox(10);
    const replyThreads = threads.filter(t => t.isReply);
    if (replyThreads.length > 0) {
      inboxSummary = `\n\nOvernight email replies (${replyThreads.length}):\n` +
        replyThreads.map(t => `- "${t.subject}" from ${t.from}`).join('\n');
    } else if (threads.length > 0) {
      inboxSummary = `\n\nInbox: ${threads.length} unread (no replies needing action)`;
    }
  } catch {
    // Gmail not configured or API error — skip silently
  }

  const context = `
Recent conversations (last 50):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000)}

Top unreviewed opportunities:
${opportunities.slice(0, 3).map(o => `- [${o.score}/100] ${o.title}: ${o.summary}`).join('\n') || 'None yet'}
${inboxSummary}
`;

  try {
    const briefing = (await think(
      'You are Jarvis. Write a concise morning briefing for Jake. Include: what happened recently, top 3 priorities for today, any opportunities to review, and any email replies that need attention. Be direct, no fluff. Use markdown headers.',
      [],
      context
    )).text;

    let overnightSummary = '';
    try {
      overnightSummary = await generateOvernightSummary();
    } catch (err) {
      console.error('Overnight summary failed (non-fatal):', err);
    }
    const fullBriefing = overnightSummary
      ? `${briefing}\n\n---\n${overnightSummary}`
      : briefing;

    const channel = discord.channels.cache.get(CHANNELS.MORNING_BRIEF) as TextChannel | undefined;
    if (channel) {
      await channel.send(`**Good morning, Jake.**\n\n${fullBriefing}`);
    }
  } catch (err) {
    console.error('Morning briefing failed:', err);
  }

  console.log('Morning briefing: sent');
}
```

**Verification:**
```bash
npx tsc --noEmit
```

**Git commit:**
```bash
git add src/overnight/briefing.ts
git commit -m "feat: add overnight email reply summary to morning brief (wave 8)"
```

---

## Railway env vars to add after all tasks are complete

```
GMAIL_CLIENT_ID=<from Google Cloud OAuth2 credentials>
GMAIL_CLIENT_SECRET=<from Google Cloud OAuth2 credentials>
GMAIL_REFRESH_TOKEN=<printed by scripts/gmail-auth.mjs>
```

---

## Final verification pass

After all 8 tasks:
```bash
npx tsc --noEmit
```

Zero errors expected. If TypeScript cannot find `googleapis` types, run:
```bash
npm install googleapis
```
The `googleapis` package ships its own TypeScript types — no `@types/googleapis` needed.

---

## Summary

| Task | File(s) | Type |
|---|---|---|
| 1 | `scripts/gmail-auth.mjs` | New — local script |
| 2 | `src/tools/gmail.ts` | New — server tool |
| 3 | `scripts/ingest-email-style.mjs` | New — local script |
| 4 | `src/brain.ts` | Edit — ToolCallResult, schemas, executors, alwaysAvailable |
| 5 | `src/discord/handlers.ts` | Edit — pendingEmailApproval map + approval gate + tool result handler |
| 6 | `src/overnight/inbox-monitor.ts` | New — overnight function |
| 7 | `src/index.ts`, `src/tools/registry.ts` | Edit — cron + registry |
| 8 | `src/overnight/briefing.ts` | Edit — morning brief inbox section |

**8 tasks, 3 new files, 5 edited files.**
