/**
 * Slack integration via Web API (bot token).
 *
 * Setup:
 *   1. Go to api.slack.com/apps → your app → OAuth & Permissions
 *   2. Copy the "Bot User OAuth Token" (starts with xoxb-)
 *   3. Set SLACK_BOT_TOKEN in Railway env vars
 *   4. Set SLACK_CHANNEL_ENGINEERING to the channel ID you want notifications in
 *      (open Slack in browser → channel URL contains the ID, e.g. C0812345678)
 *
 * Required bot scopes: chat:write
 * Add the bot to the channel: /invite @YourBotName in Slack
 */

async function postToSlackChannel(channel: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    console.error(`Slack API request failed: ${res.status}`);
    return;
  }

  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error(`Slack API error: ${data.error}`);
  }
}

/** Post a build/deploy notification to the engineering Slack channel (if configured). */
export async function notifySlackEngineering(message: string): Promise<void> {
  const channel = process.env.SLACK_CHANNEL_ENGINEERING;
  if (!channel) return; // Slack is optional — silently skip if not configured
  await postToSlackChannel(channel, message);
}
