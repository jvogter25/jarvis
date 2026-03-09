export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  error?: string;
}

/**
 * Fetch and extract readable content from a URL using Jina.ai Reader.
 * No API key, no sandbox, no browser install — just clean text from any URL.
 * task: natural-language description of what to extract (logged for context).
 */
export async function browseUrl(url: string, task: string): Promise<BrowseResult> {
  console.log(`browseUrl: ${task} — ${url}`);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return { url, title: '', content: '', error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const text = await res.text();
    // Jina returns "Title: ...\nURL Source: ...\n\nMarkdown Content:\n..."
    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? '';
    // Strip Jina header lines, keep the content body (cap at 8000 chars)
    const content = text.replace(/^(Title:|URL Source:|Markdown Content:)[^\n]*\n/gm, '').trim().slice(0, 8000);

    return { url, title, content };
  } catch (err) {
    return { url, title: '', content: '', error: (err as Error).message };
  }
}

export interface InteractResult {
  url: string;
  result: string;
  error?: string;
}

/**
 * Run Playwright against a live page via Browserbase (managed cloud browser).
 * No local browser install needed — connects over CDP.
 * Use for: clicking, form filling, CSS inspection, JS execution, screenshots.
 * playwrightCode runs after page.goto() — use page.* methods, console.log() results.
 */
export async function interactWithPage(url: string, playwrightCode: string): Promise<InteractResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return { url, result: '', error: 'BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set' };
  }

  // Create a Browserbase session
  let session: { id: string; connectUrl: string };
  try {
    const sessionRes = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': apiKey },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sessionRes.ok) {
      return { url, result: '', error: `Browserbase session failed: ${sessionRes.status} ${sessionRes.statusText}` };
    }
    session = await sessionRes.json() as { id: string; connectUrl: string };
  } catch (err) {
    return { url, result: '', error: `Browserbase connection failed: ${(err as Error).message}` };
  }

  // Run Playwright in E2B — connects to remote browser, no Chromium install needed
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP(${JSON.stringify(session.connectUrl)});
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });

  ${playwrightCode}

  await browser.close();
})().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
`;

  const { runShell } = await import('./shell.js');
  const shellResult = await runShell(
    ['npm install playwright --quiet', 'node script.js'],
    [{ path: 'script.js', content: script }]
  );

  const lastStderr = shellResult.stderr.split('\n').filter((l: string) => l.trim()).at(-1) ?? '';
  if (shellResult.exitCode !== 0 || lastStderr.includes('"error"')) {
    let errMsg = lastStderr;
    try { errMsg = JSON.parse(lastStderr).error ?? lastStderr; } catch {}
    return { url, result: '', error: errMsg };
  }

  return { url, result: shellResult.stdout || 'Done.' };
}
