/**
 * Slack integration via Incoming Webhooks.
 * No bot token required — just a webhook URL per channel.
 *
 * Setup: Slack → Your apps → Create App → Incoming Webhooks → Activate → Add to channel.
 * Set SLACK_WEBHOOK_ENGINEERING in env for build/deploy notifications.
 */

export async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Slack webhook failed: ${res.status} ${body}`);
  }
}

/** Post a build/deploy notification to the engineering Slack channel (if configured). */
export async function notifySlackEngineering(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_ENGINEERING;
  if (!webhookUrl) return; // Slack is optional — silently skip if not configured
  await postToSlack(webhookUrl, message);
}
