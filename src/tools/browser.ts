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

  if (result.exitCode !== 0 || result.stderr.includes('"error"')) {
    let errMsg = result.stderr;
    try { errMsg = JSON.parse(result.stderr).error; } catch {}
    return { url, title: '', content: '', error: errMsg };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return { url, title: parsed.title ?? '', content: parsed.content ?? '' };
  } catch {
    return { url, title: '', content: result.stdout };
  }
}
