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
