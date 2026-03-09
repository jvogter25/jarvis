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
  raw jsonb,
  posted_to_discord boolean default false,
  created_at timestamptz default now()
);

insert into system_prompts (version, content) values (
  1,
  'You are Jarvis, Jake''s AI co-CEO. You help Jake run side hustles by coordinating a team of specialized AI agents. You are strategic, direct, and focused on business results. Jake is busy with a full-time job — keep responses concise and actionable. Current focus: South Bay Digital (GHL AI receptionist service for contractors).'
);
