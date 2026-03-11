import { Message as DiscordMessage, TextChannel } from 'discord.js';
import { CHANNELS, splitMessage } from '../discord/channels.js';
import { AGENT_PROMPTS } from '../config/agentPrompts.js';
import { getDiscordClient } from '../discord/client.js';

/**
 * Handles the !setup-agents command.
 *
 * For each agent in AGENT_PROMPTS:
 *   - Resolves the channel ID from the agent's env var
 *   - Skips the #jarvis channel unconditionally (safety guard)
 *   - In dry-run mode: logs what would be written without touching Discord
 *   - In live mode: updates the Discord channel topic via the Discord API
 *     and reports ✅ / ❌ per channel
 *
 * Usage:
 *   !setup-agents           — write prompts to all agent channels
 *   !setup-agents --dry-run — preview changes without writing anything
 */
export async function handleSetupAgents(
  msg: DiscordMessage,
  dryRun: boolean
): Promise<void> {
  const channel = msg.channel as TextChannel;
  const client = getDiscordClient();

  if (!client) {
    await channel.send('❌ Discord client is not available. Cannot run setup.');
    return;
  }

  const header = dryRun
    ? '🔍 **Dry run** — no changes will be written:\n'
    : '⚙️ **Setting up agent channels...**\n';
  await channel.send(header);

  const results: string[] = [];

  for (const agent of AGENT_PROMPTS) {
    const channelId = process.env[agent.channelEnvVar];

    // Missing env var
    if (!channelId) {
      results.push(
        `❌ **${agent.displayName}**: env var \`${agent.channelEnvVar}\` is not set — skipped`
      );
      continue;
    }

    // Hardcoded safety: never touch #jarvis
    if (channelId === CHANNELS.JARVIS) {
      results.push(
        `⏭️ **${agent.displayName}**: skipped — channel is the protected #jarvis channel`
      );
      continue;
    }

    if (dryRun) {
      const preview = agent.prompt.length > 100
        ? agent.prompt.slice(0, 100) + '...'
        : agent.prompt;
      results.push(
        `🔍 **${agent.displayName}** (\`${channelId}\`): would set topic to:\n> ${preview}`
      );
      continue;
    }

    // Live write — hit the Discord API
    try {
      const fetched = await client.channels.fetch(channelId);

      if (!fetched || !(fetched instanceof TextChannel)) {
        results.push(
          `❌ **${agent.displayName}**: channel \`${channelId}\` not found or is not a text channel`
        );
        continue;
      }

      // Discord channel topics are capped at 1024 characters
      const topic = agent.prompt.slice(0, 1024);
      await fetched.edit({ topic });

      results.push(`✅ **${agent.displayName}**: system prompt written to channel topic`);
    } catch (err) {
      results.push(
        `❌ **${agent.displayName}**: failed — ${(err as Error).message}`
      );
    }
  }

  const summary = results.join('\n');
  for (const chunk of splitMessage(summary)) {
    await channel.send(chunk);
  }

  const footer = dryRun
    ? '\n_Run `!setup-agents` without `--dry-run` to apply these changes._'
    : '\n_Agent channel setup complete._';
  await channel.send(footer);
}
