import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export type Message = {
  role: 'user' | 'assistant';
  content: string;
};

export async function getRecentMessages(channelId: string, limit = 20): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).reverse() as Message[];
}

export async function saveMessage(channelId: string, role: 'user' | 'assistant', content: string) {
  const { error } = await supabase
    .from('messages')
    .insert({ channel_id: channelId, role, content });

  if (error) throw error;
}

export async function getSystemPrompt(): Promise<string> {
  const { data, error } = await supabase
    .from('system_prompts')
    .select('content')
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data.content;
}

export async function saveSystemPrompt(content: string) {
  const { data: latest } = await supabase
    .from('system_prompts')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .single();

  const nextVersion = (latest?.version ?? 0) + 1;

  const { error } = await supabase
    .from('system_prompts')
    .insert({ version: nextVersion, content });

  if (error) throw error;
}

export async function saveOpportunity(opp: {
  source: string;
  title: string;
  summary: string;
  score: number;
  leverage_note?: string;
  deep_dive?: string;
  raw: unknown;
}) {
  const { error } = await supabase
    .from('opportunities')
    .insert({ ...opp });

  if (error) throw error;
}

export async function getUnpostedOpportunities() {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('posted_to_discord', false)
    .order('score', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function markOpportunityPosted(id: string) {
  const { error } = await supabase
    .from('opportunities')
    .update({ posted_to_discord: true })
    .eq('id', id);

  if (error) throw error;
}

export async function hasOpportunityByTitle(title: string): Promise<boolean> {
  const { count } = await supabase
    .from('opportunities')
    .select('id', { count: 'exact', head: true })
    .eq('title', title);
  return (count ?? 0) > 0;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: 'planning' | 'building' | 'staging' | 'live' | 'archived';
  build_type: 'landing_page' | 'full_app';
  description?: string;
  github_repo?: string;
  vercel_project_id?: string;
  staging_url?: string;
  production_url?: string;
  created_at: string;
  updated_at: string;
}

export async function createProject(input: {
  name: string;
  slug: string;
  build_type: 'landing_page' | 'full_app';
  description?: string;
}): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ ...input, status: 'planning' })
    .select()
    .single();
  if (error) throw error;
  return data as Project;
}

export async function updateProject(slug: string, updates: Omit<Partial<Project>, 'id' | 'slug' | 'created_at' | 'updated_at'>): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('slug', slug);
  if (error) throw error;
}

export async function getProjects(status?: Project['status']): Promise<Project[]> {
  const { data, error } = status
    ? await supabase.from('projects').select('*').eq('status', status).order('created_at', { ascending: false })
    : await supabase.from('projects').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Project[];
}

export async function getProject(slug: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) return null;
  return data as Project;
}

// ─── Knowledge Base ───────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  domain: string;
  source_url?: string;
  title: string;
  content: string;
  key_insights: string[];
  created_at: string;
}

export async function saveKnowledge(entry: {
  domain: string;
  source_url?: string;
  title: string;
  content: string;
  key_insights: string[];
}): Promise<void> {
  const { error } = await supabase.from('knowledge_base').insert(entry);
  if (error) throw error;
}

export async function searchKnowledge(domain: string, limit = 5): Promise<KnowledgeEntry[]> {
  const query = supabase
    .from('knowledge_base')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const { data, error } = domain === 'all'
    ? await query
    : await query.eq('domain', domain);

  if (error) throw error;
  return (data ?? []) as KnowledgeEntry[];
}

export async function getRecentKnowledge(limit = 20): Promise<KnowledgeEntry[]> {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as KnowledgeEntry[];
}

// ─── Project Configs ──────────────────────────────────────────────────────────

export interface ProjectChannels {
  general: string;
  research: string;
  engineering: string;
  marketing: string;
  design: string;
  morning_brief: string;
  overnight_log: string;
}

export interface ProjectConfig {
  id: string;
  slug: string;
  system_prompt: string;
  last_synced_at: string;
  discord_category_id: string;
  channels: ProjectChannels;
  github_repo?: string;
  created_at: string;
  updated_at: string;
}

export async function createProjectConfig(input: {
  slug: string;
  system_prompt: string;
  discord_category_id: string;
  channels: ProjectChannels;
  github_repo?: string;
}): Promise<ProjectConfig> {
  const { data, error } = await supabase
    .from('project_configs')
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as ProjectConfig;
}

export async function getProjectConfig(slug: string): Promise<ProjectConfig | null> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) return null;
  return data as ProjectConfig;
}

export async function getAllProjectConfigs(): Promise<ProjectConfig[]> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectConfig[];
}

export async function getProjectConfigByChannelId(channelId: string): Promise<ProjectConfig | null> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*');
  if (error) return null;
  return (data ?? []).find((p: ProjectConfig) =>
    p.channels && typeof p.channels === 'object' && Object.values(p.channels).includes(channelId)
  ) ?? null;
}

export async function updateProjectConfig(slug: string, updates: Partial<Pick<ProjectConfig, 'system_prompt' | 'last_synced_at' | 'github_repo'>>): Promise<void> {
  const { error } = await supabase
    .from('project_configs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('slug', slug);
  if (error) throw error;
}

export async function saveShutdownState(state: Record<string, unknown>): Promise<void> {
  await supabase.from('shutdown_state').upsert({
    id: 'singleton',
    state,
    saved_at: new Date().toISOString(),
  }, { onConflict: 'id' });
}

export async function loadShutdownState(): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from('shutdown_state').select('state').eq('id', 'singleton').single();
  return data?.state ?? null;
}
