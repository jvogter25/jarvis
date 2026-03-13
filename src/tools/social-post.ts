// src/tools/social-post.ts

export interface SocialPostResult {
  platform: 'twitter' | 'reddit';
  agent: 'vantage' | 'sentinel';
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Post a tweet from an agent account using Browserbase Playwright.
 * agent: 'vantage' | 'sentinel' — determines which credentials to use.
 */
export async function postToTwitter(
  agent: 'vantage' | 'sentinel',
  text: string
): Promise<SocialPostResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const email = agent === 'vantage'
    ? process.env.TWITTER_VANTAGE_EMAIL
    : process.env.TWITTER_SENTINEL_EMAIL;
  const password = agent === 'vantage'
    ? process.env.TWITTER_VANTAGE_PASSWORD
    : process.env.TWITTER_SENTINEL_PASSWORD;

  if (!apiKey || !projectId) return { platform: 'twitter', agent, success: false, error: 'BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set' };
  if (!email || !password) return { platform: 'twitter', agent, success: false, error: `TWITTER_${agent.toUpperCase()}_EMAIL or PASSWORD not set` };

  let connectUrl: string;
  try {
    const sessionRes = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': apiKey },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sessionRes.ok) return { platform: 'twitter', agent, success: false, error: `Browserbase session failed: ${sessionRes.status}` };
    const session = await sessionRes.json() as { id: string; connectUrl: string };
    connectUrl = session.connectUrl;
  } catch (err) {
    return { platform: 'twitter', agent, success: false, error: `Browserbase error: ${(err as Error).message}` };
  }

  let browser: import('playwright-core').Browser | undefined;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();

    // Log in
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[name="text"]', { timeout: 10000 });
    await page.fill('input[name="text"]', email);
    await page.click('button[role="button"]:has-text("Next")');
    await page.waitForSelector('input[name="password"]', { timeout: 10000 });
    await page.fill('input[name="password"]', password);
    await page.click('button[data-testid="LoginForm_Login_Button"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });

    // Compose tweet
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await page.fill('[data-testid="tweetTextarea_0"]', text);
    await page.waitForTimeout(1000);
    await page.click('[data-testid="tweetButtonInline"]');
    await page.waitForTimeout(3000);

    return { platform: 'twitter', agent, success: true };
  } catch (err) {
    return { platform: 'twitter', agent, success: false, error: (err as Error).message };
  } finally {
    await browser?.close();
  }
}

/**
 * Post to a Reddit subreddit as an agent account using Browserbase Playwright.
 * For replies to existing threads, pass replyToUrl.
 * For new posts, pass title + subreddit.
 */
export async function postToReddit(
  agent: 'vantage' | 'sentinel',
  options: {
    subreddit: string;
    title?: string;
    body: string;
    replyToUrl?: string;
  }
): Promise<SocialPostResult> {
  if (!options.replyToUrl && !options.title) {
    return { platform: 'reddit', agent, success: false, error: 'title is required for new posts' };
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const username = agent === 'vantage'
    ? process.env.REDDIT_VANTAGE_USERNAME
    : process.env.REDDIT_SENTINEL_USERNAME;
  const password = agent === 'vantage'
    ? process.env.REDDIT_VANTAGE_PASSWORD
    : process.env.REDDIT_SENTINEL_PASSWORD;

  if (!apiKey || !projectId) return { platform: 'reddit', agent, success: false, error: 'BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set' };
  if (!username || !password) return { platform: 'reddit', agent, success: false, error: `REDDIT_${agent.toUpperCase()}_USERNAME or PASSWORD not set` };

  let connectUrl: string;
  try {
    const sessionRes = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': apiKey },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sessionRes.ok) return { platform: 'reddit', agent, success: false, error: `Browserbase session failed: ${sessionRes.status}` };
    const session = await sessionRes.json() as { id: string; connectUrl: string };
    connectUrl = session.connectUrl;
  } catch (err) {
    return { platform: 'reddit', agent, success: false, error: `Browserbase error: ${(err as Error).message}` };
  }

  let browser: import('playwright-core').Browser | undefined;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();

    // Log in via old.reddit for simpler DOM
    await page.goto('https://old.reddit.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('#user_login', username);
    await page.fill('#passwd_login', password);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });

    let postedUrl: string;

    if (options.replyToUrl) {
      await page.goto(options.replyToUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('textarea[name="text"]', { timeout: 10000 });
      await page.fill('textarea[name="text"]', options.body);
      await page.click('button[type="submit"]:has-text("save")');
      await page.waitForTimeout(3000);
      postedUrl = options.replyToUrl;
    } else {
      await page.goto(`https://old.reddit.com/r/${options.subreddit}/submit`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.click('#text-desc');
      await page.fill('#title', options.title ?? '');
      await page.fill('textarea[name="text"]', options.body);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
      postedUrl = page.url();
    }

    return { platform: 'reddit', agent, success: true, url: postedUrl };
  } catch (err) {
    return { platform: 'reddit', agent, success: false, error: (err as Error).message };
  } finally {
    await browser?.close();
  }
}
