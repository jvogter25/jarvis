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
  isReply: boolean;
}

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

      const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'minimal',
      });
      const messageCount = threadRes.data.messages?.length ?? 1;

      threads.push({ threadId, subject, from, snippet, isReply: messageCount > 1 });
    } catch (err) {
      console.error(`[gmail] Failed to fetch message ${msg.id}:`, err);
    }
  }

  return threads;
}

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

    const body = findTextPart(msg.payload);
    parts.push(`From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.trim()}`);
  }

  return parts.join('\n\n---\n\n');
}

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
