import { Client, ChannelType } from 'discord.js';
import { createProjectConfig, getSystemPrompt, ProjectChannels } from '../memory/supabase.js';
import { octokit } from '../github/client.js';

const OWNER = process.env.GITHUB_OWNER!;

const PROJECT_CHANNELS: Array<{ key: keyof ProjectChannels; name: string; topic: string }> = [
  { key: 'general',       name: 'general',       topic: 'Main chat with Jarvis about this project' },
  { key: 'research',      name: 'research',       topic: 'Competitor tracking, market validation' },
  { key: 'engineering',   name: 'engineering',    topic: 'Build updates, PRs, deploys' },
  { key: 'marketing',     name: 'marketing',      topic: 'Copy, campaigns, launch plans' },
  { key: 'design',        name: 'design',         topic: 'Design decisions, components' },
  { key: 'morning_brief', name: 'morning-brief',  topic: 'Daily project status from Jarvis' },
  { key: 'overnight_log', name: 'overnight-log',  topic: 'What Jarvis worked on overnight' },
];

export interface ProjectSetupResult {
  slug: string;
  discordCategoryId: string;
  channels: ProjectChannels;
  githubRepo: string;
  generalChannelId: string;
}

export async function setupProject(
  discord: Client,
  projectName: string,
  slug: string,
  description: string
): Promise<ProjectSetupResult> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error('DISCORD_GUILD_ID not set in Railway env vars');

  const guild = discord.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found in cache — bot may not be in server`);

  console.log(`[project-setup] Creating Discord category for ${slug}...`);

  // Create category
  const category = await guild.channels.create({
    name: projectName.toUpperCase(),
    type: ChannelType.GuildCategory,
  });

  // Create all 7 channels inside the category
  const channelIds: Partial<ProjectChannels> = {};
  for (const ch of PROJECT_CHANNELS) {
    const created = await guild.channels.create({
      name: ch.name,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: ch.topic,
    });
    channelIds[ch.key] = created.id;
    console.log(`[project-setup] Created #${ch.name}: ${created.id}`);
  }

  const channels = channelIds as ProjectChannels;

  // Create GitHub repo
  console.log(`[project-setup] Creating GitHub repo ${slug}...`);
  await octokit.rest.repos.createForAuthenticatedUser({
    name: slug,
    description,
    private: false,
    auto_init: true,
  });

  // Fork global system prompt as project's system prompt
  const globalPrompt = await getSystemPrompt();
  const projectPrompt = `${globalPrompt}\n\n---\nPROJECT CONTEXT: ${projectName}\n${description}\n\nYou are currently working in the ${projectName} project workspace. Focus all responses, research, and execution on this project.`;

  // Save project config to Supabase
  await createProjectConfig({
    slug,
    system_prompt: projectPrompt,
    discord_category_id: category.id,
    channels,
    github_repo: slug,
  });

  console.log(`[project-setup] Project ${slug} setup complete`);

  return {
    slug,
    discordCategoryId: category.id,
    channels,
    githubRepo: `https://github.com/${OWNER}/${slug}`,
    generalChannelId: channels.general,
  };
}
