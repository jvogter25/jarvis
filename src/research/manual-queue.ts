import { RawPost } from './scraper.js';

/**
 * Manually queued research opportunities injected into the nightly research loop.
 * Add entries here to have Jarvis score and post them to #research during the next run.
 * Once an entry has been processed its title is deduped by hasOpportunityByTitle, so
 * it will only be scored and posted once.
 */
export const MANUAL_QUEUE: RawPost[] = [
  {
    source: 'web',
    title: 'Shorts AI Pipeline — AI-generated faceless YouTube Shorts via Claude Code + Postiz',
    body: `Via @jacobgrowth on Twitter/X.

Opportunity: Build a fully automated faceless YouTube Shorts pipeline. Use Claude Code to generate scripts and voiceovers, stitch clips automatically, then publish multi-platform (YouTube Shorts, TikTok, Instagram Reels) via Postiz. Monetize through YouTube Content Rewards campaigns and affiliate placements.

Stack: Claude Code (script + narration generation), Postiz (multi-platform scheduler/publisher), ElevenLabs or similar TTS, stock video APIs.

Key signals:
- Faceless content channels are exploding in 2025-2026; creators report $1k-$10k/mo from Content Rewards on modest view counts
- Postiz is an open-source Buffer alternative with a scheduling API, dramatically lowering distribution cost
- No dominant <$100/mo end-to-end solution — creators cobble together 4-6 tools manually
- Automation ceiling is high: once prompt templates are tuned, the pipeline runs with near-zero human touch
- Income potential: agency retainer ($500-2k/mo per client) or SaaS subscription ($49-149/mo self-serve)
- Competition: no single tool owns AI faceless video + cross-platform publish + Content Rewards optimization

Score dimensions requested: automation ceiling, income potential, competition gap.`,
    url: 'https://twitter.com/jacobgrowth',
    score: 0,
  },
  {
    source: 'web',
    title: 'GEO SEO Audits — Agency offer wrapping geo-seo-claude open-source tool at $500-1500/audit',
    body: `Via @simplifyinai on Twitter/X.

Opportunity: geo-seo-claude is an open-source CLI/tool that audits websites for visibility in AI search engines — ChatGPT browsing, Perplexity, Claude web search, Google AI Overviews. Wrap it as a productized agency offer: $500-1500/audit, ongoing monthly monitoring retainer at $200-500/mo.

Key signals:
- GEO (Generative Engine Optimization) is a newly coined discipline; most SEO agencies have no offering here yet
- CMOs are actively asking "why isn't our brand showing up in ChatGPT results?" — clear, recurring business pain with budget attached
- The open-source tool exists and does the heavy lifting — low build cost, fast time-to-offer
- No dominant <$100/mo solution: Semrush/Ahrefs have no AI-engine-specific audit; specialty tools are early-stage and expensive
- Market timing: 12-24 month window before mainstream SEO agencies add this to their standard stack
- Scalable: audits are deliverable-based, can be systematized with Claude generating the report narrative

Score dimensions requested: market timing, service scalability, competition gap.`,
    url: 'https://twitter.com/simplifyinai',
    score: 0,
  },
  {
    source: 'web',
    title: 'Paperclip AI Company OS — Open-source agent-to-business-role framework, 1.4K GitHub stars, #1 Trendshift',
    body: `Via @sukh_saroy on Twitter/X.

Opportunity: Paperclip is an open-source framework for assigning AI agents to business roles (CEO, CFO, CMO, etc.), setting budgets per role, and letting them run. The "Clipmart" marketplace sells pre-built company configurations. Currently at 1.4K GitHub stars and trending #1 on Trendshift.

Key signals:
- 1,400 GitHub stars in early traction signals strong developer and founder interest
- #1 Trendshift ranking indicates strong week-over-week momentum — early mover advantage window is open
- Income model: Clipmart marketplace (rev share on config sales), hosted SaaS tier, consulting/implementation for SMBs
- Open-source core lowers CAC — freemium funnel is proven in devtools (Supabase, Appwrite, etc.)
- Risk: production readiness unknown — star counts don't always mean stability; needs code review
- Market gap: no dominant <$100/mo "AI operating system for small businesses" — closest competitors are n8n/Zapier but they're workflow tools, not role-based agent orchestration

Score dimensions requested: production readiness, income model viability, competition.`,
    url: 'https://twitter.com/sukh_saroy',
    score: 0,
  },
];
