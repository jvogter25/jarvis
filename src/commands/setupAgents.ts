import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import { AGENT_CONFIGS, AgentConfig, EXCLUDED_CHANNEL_ENV_KEY } from '../config/agentPrompts.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function findAgent(name: string): AgentConfig | undefined {
  return AGENT_CONFIGS.find((a) => a.name === name);
}

interface SetupResult {
  agentName: string;
  role: string;
  channelId: string | undefined;
  status: 'written' | 'skipped_jarvis' | 'skipped_no_channel' | 'dry_run' | 'error';
  error?: string;
}

async function upsertChannelSystemPrompt(
  channelId: string,
  agentName: string,
  prompt: string
): Promise<void> {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );
  const { error } = await supabase
    .from('channel_system_prompts')
    .upsert(
      { channel_id: channelId, agent_name: agentName, prompt, updated_at: new Date().toISOString() },
      { onConflict: 'channel_id' }
    );
  if (error) throw error;
}

export async function handleSetupAgents(msg: DiscordMessage): Promise<void> {
  const channel = msg.channel as SendableChannel;
  const isDryRun = msg.content.includes('--dry-run');
  const jarvisChannelId = process.env[EXCLUDED_CHANNEL_ENV_KEY];

  const prefix = isDryRun ? '🔍 **[DRY RUN] !setup-agents**' : '⚙️ **!setup-agents**';
  await channel.send(
    `${prefix} — ${isDryRun ? 'Simulating' : 'Writing'} system prompts for ${AGENT_CONFIGS.length} agents...\n` +
    `\`#jarvis\` is hardcoded as excluded and will never be overwritten.`
  );

  const results: SetupResult[] = [];

  for (const agent of AGENT_CONFIGS) {
    const channelId = process.env[agent.channelEnvKey];

    // Always skip #jarvis
    if (channelId && channelId === jarvisChannelId) {
      results.push({ agentName: agent.name, role: agent.role, channelId, status: 'skipped_jarvis' });
      continue;
    }

    // Skip if channel env var is not configured
    if (!channelId) {
      results.push({ agentName: agent.name, role: agent.role, channelId: undefined, status: 'skipped_no_channel' });
      continue;
    }

    if (isDryRun) {
      results.push({ agentName: agent.name, role: agent.role, channelId, status: 'dry_run' });
      continue;
    }

    try {
      await upsertChannelSystemPrompt(channelId, agent.name, agent.systemPrompt);
      results.push({ agentName: agent.name, role: agent.role, channelId, status: 'written' });
    } catch (err) {
      results.push({
        agentName: agent.name,
        role: agent.role,
        channelId,
        status: 'error',
        error: (err as Error).message,
      });
    }
  }

  // Build status report
  const lines = results.map((r) => {
    const channelRef = r.channelId ? `<#${r.channelId}>` : '`(unset)`';
    switch (r.status) {
      case 'written':
        return `✅ **${r.agentName}** (${r.role}) → ${channelRef}`;
      case 'dry_run':
        return `📝 **${r.agentName}** (${r.role}) → ${channelRef} *(would write)*`;
      case 'skipped_jarvis':
        return `🔒 **${r.agentName}** (${r.role}) → ${channelRef} *(skipped — #jarvis is protected)*`;
      case 'skipped_no_channel':
        return `⚠️ **${r.agentName}** (${r.role}) → \`${findAgent(r.agentName)?.channelEnvKey ?? 'unknown'}\` not set in env`;
      case 'error':
        return `❌ **${r.agentName}** (${r.role}) → ${channelRef} — error: ${r.error}`;
    }
  });

  const written = results.filter((r) => r.status === 'written').length;
  const dryRun = results.filter((r) => r.status === 'dry_run').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped_jarvis' || r.status === 'skipped_no_channel').length;

  const summary = isDryRun
    ? `\n\n**Dry run complete.** ${dryRun} would be written, ${skipped} skipped. Run \`!setup-agents\` without \`--dry-run\` to apply.`
    : `\n\n**Done.** ${written} written, ${skipped} skipped${errors > 0 ? `, ${errors} failed` : ''}.`;

  await channel.send(lines.join('\n') + summary);
}

