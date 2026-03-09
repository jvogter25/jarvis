-- Run this in the Supabase SQL Editor

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

create table if not exists system_prompts (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  content text not null,
  created_at timestamptz default now()
);

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  title text not null,
  summary text not null,
  score int not null,
  leverage_note text,
  deep_dive text,
  raw jsonb,
  posted_to_discord boolean default false,
  created_at timestamptz default now()
);

-- Run this if the table already exists to add the new columns:
-- alter table opportunities add column if not exists leverage_note text;
-- alter table opportunities add column if not exists deep_dive text;

insert into system_prompts (version, content) values (
  1,
  'You are Jarvis, Jake''s AI co-CEO. You help Jake run side hustles by coordinating a team of specialized AI agents. You are strategic, direct, and focused on business results. Jake is busy with a full-time job — keep responses concise and actionable. Current focus: South Bay Digital (GHL AI receptionist service for contractors).'
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  status text not null default 'planning',
  -- status: planning | building | staging | live | archived
  build_type text not null default 'landing_page',
  -- build_type: landing_page | full_app
  description text,
  github_repo text,
  vercel_project_id text,
  staging_url text,
  production_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Knowledge base: training material Jake feeds Jarvis
CREATE TABLE IF NOT EXISTS knowledge_base (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  domain text NOT NULL, -- 'sales', 'marketing', 'design', 'engineering', 'general'
  source_url text,
  title text NOT NULL,
  content text NOT NULL,
  key_insights jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

-- Project configs: per-project system prompts + Discord channel map
CREATE TABLE IF NOT EXISTS project_configs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  system_prompt text NOT NULL,
  last_synced_at timestamptz DEFAULT now(),
  discord_category_id text NOT NULL,
  channels jsonb NOT NULL DEFAULT '{}',
  github_repo text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
