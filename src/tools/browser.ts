import { runShell } from './shell.js';

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  error?: string;
}

/**
 * Navigate to a URL and extract text content using Playwright inside E2B.
 * `task` is a natural-language description of what to extract (passed as context in the script).
 */
export async function browseUrl(url: string, task: string): Promise<BrowseResult> {
  const script = `
// Task: ${task}
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const content = await page.evaluate(() => document.body.innerText);
  console.log(JSON.stringify({ title, content: content.slice(0, 8000) }));
  await browser.close();
})().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
`;

  const result = await runShell(
    [
      'npm install playwright --quiet',
      'npx playwright install chromium --with-deps',
      'node script.js',
    ],
    [{ path: 'script.js', content: script }]
  );

  const lastStderr = result.stderr.split('\n').filter(l => l.trim()).at(-1) ?? '';
  if (result.exitCode !== 0 || lastStderr.includes('"error"')) {
    let errMsg = lastStderr;
    try { errMsg = JSON.parse(lastStderr).error ?? lastStderr; } catch {}
    return { url, title: '', content: '', error: errMsg };
  }

  const jsonLine = result.stdout.split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!jsonLine) {
    return { url, title: '', content: result.stdout, error: 'No JSON output from script' };
  }
  try {
    const parsed = JSON.parse(jsonLine);
    return { url, title: parsed.title ?? '', content: parsed.content ?? '' };
  } catch {
    return { url, title: '', content: result.stdout, error: 'Failed to parse script output' };
  }
}
