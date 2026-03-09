# Wave 4: Build Machine Design

**Goal:** Transform Jarvis from a smart chatbot into an autonomous build-and-ship system — full Next.js apps and landing pages deployed from Discord, with Jake's personal design aesthetic baked into every build.

**Architecture:** Four new systems layered on top of the existing Jarvis stack: Design Intelligence (CSS extraction + component library), Build Pipeline (template fork → GitHub → Vercel), Project Memory (Supabase projects table), and Overnight Mode (staging-gated autonomous execution).

**Tech Stack:** Playwright/Browserbase (CSS extraction), GitHub API/Octokit (template fork + file push), Vercel API (deploy promotion), Supabase (projects table), Discord.js (new #design-elements channel + #engineering approval flow), existing Claude tool_use loop

---

## Architecture Overview

```
#design-elements (Discord)
    ↓ URL drops → Playwright CSS extraction
    ↓ Code exports → /design-refs/components/
    ↓ Screenshots → /design-refs/inspiration/
         ↓
    design-tokens.json (jarvis repo)
         ↓ injected into every build
         ↓
Jarvis Build Pipeline
    Jake: "build landing page for X"
    → Jarvis confirms plan + suggests design elements (complex task = plan first)
    → forks Next.js template repo
    → generates content + applies design tokens + injects components
    → pushes to GitHub → Vercel preview URL
    → posts to #engineering, waits for Jake approval
    → Jake approves → promotes to production
         ↓
    projects table (Supabase)
    tracks: name, status, github_repo, vercel_url
```

---

## Section 1: Design Intelligence Layer

### Discord Channel
New channel `#design-elements` — dedicated design library, keeps `#jarvis` uncluttered.

### Three Input Types

**URL drops** — Jake posts a URL in `#design-elements`. Jarvis uses Playwright (Browserbase) to extract:
- CSS custom properties (`--primary`, `--font-heading`, etc.)
- Computed colors (background, text, accent)
- Font families and weights
- Border radius, spacing patterns, section padding
Parsed and merged non-destructively into `design-tokens.json` in the jarvis repo. New values add/override individual keys; existing tokens not wiped.

**Code exports (Variant.com + other tools)** — Jake pastes exported component code into `#design-elements`. Jarvis detects code block, asks for a component name if not provided, files to `/design-refs/components/{name}.tsx` on GitHub.

**Screenshots/images** — Jake uploads an image. Jarvis stores to `/design-refs/inspiration/{timestamp}-{description}.png` with a Claude-generated description tag for searchability.

### design-tokens.json Structure
```json
{
  "colors": {
    "primary": "#0066FF",
    "background": "#0A0A0A",
    "surface": "#1A1A1A",
    "text": "#FFFFFF",
    "accent": "#00D4FF"
  },
  "fonts": {
    "heading": "Inter",
    "body": "Inter",
    "mono": "JetBrains Mono"
  },
  "radius": {
    "card": "12px",
    "button": "8px",
    "full": "9999px"
  },
  "spacing": {
    "section": "80px",
    "card": "24px",
    "gap": "16px"
  },
  "sources": [
    "https://stripe.com — extracted 2026-03-09",
    "Variant export: pricing-card — 2026-03-09"
  ]
}
```

---

## Section 2: Build Pipeline

### Template Repository
`jvogter25/jarvis-template` — minimal Next.js 14 app with:
- Tailwind CSS configured with design token injection
- CSS variables from `design-tokens.json` applied globally
- Placeholder page sections (hero, features, pricing, CTA, footer)
- TypeScript, ESLint, basic SEO setup

Jarvis never modifies this repo directly. It forks it for every new project.

### Build Types
- **Landing page** — single Next.js page, ~30 min, no backend. For: product launches, waitlists, marketing sites.
- **Full app** — multi-page with API routes, optional auth scaffold, ~2-3hr. Runs overnight. For: SaaS tools, onboarding flows, client-facing portals.

### Build Flow (Step by Step)

1. **Jake requests build**: "build a landing page for [product] targeting [audience]"
2. **Jarvis detects complex task** → scans design library for relevant elements → posts plan to `#engineering`:
   > "Planning [product] landing page for [audience].
   > Found 3 design elements that might fit:
   > — `card-component.tsx` (clean product card)
   > — Stripe colors/fonts (minimal, high-trust feel)
   > — `hero-section.tsx` (bold headline layout)
   > Want to use these, swap any, or add others? Say 'looks good' to proceed."
3. **Jake approves/adjusts** → Jarvis proceeds
4. **Jarvis executes**:
   - Forks `jarvis-template` → creates `jvogter25/{project-slug}` on GitHub
   - Reads `design-tokens.json` → injects into Tailwind config + global CSS
   - Pulls specified components from `/design-refs/components/`
   - Generates page content via Claude (copy, section order, layout logic)
   - Pushes all files to new repo
5. **Vercel auto-deploys** (GitHub org connected) → preview URL ready in ~60s
6. **Jarvis posts to `#engineering`**:
   > "Staging ready: https://project-slug.vercel.app
   > Reply 'ship it' to promote to production."
7. **Jake approves** → Jarvis promotes via Vercel API → updates Supabase project record to `live`

### Design Element Selection
- If Jake names elements in request: "build using the Stripe colors and my card component" → Jarvis skips suggestion step, confirms those directly
- If library is empty: falls back to `design-tokens.json` defaults with note: "No matching components yet — building with base design tokens"

---

## Section 3: Project Memory

### Supabase `projects` Table
```sql
CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  -- status: planning | building | staging | live | archived
  build_type TEXT NOT NULL DEFAULT 'landing_page',
  -- build_type: landing_page | full_app
  description TEXT,
  github_repo TEXT,
  vercel_url TEXT,
  staging_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Queries Jarvis Can Answer
- "What are we building?" → lists `building` + `planning` projects
- "What's live?" → lists `live` projects with URLs
- "What's waiting on me?" → lists `staging` projects needing approval
- "Archive [project]" → updates status to `archived`

### Morning Brief Integration
Daily `#morning-brief` includes project status summary:
> "Projects: 2 live, 1 staging (needs your approval), 1 in progress overnight."

---

## Section 4: Overnight Mode

### Trigger
Jake explicitly activates: "tonight, build X and Y — don't ship anything live" or "overnight mode: [instructions]"

Jarvis confirms: "Got it. I'll build [X and Y] tonight and have staging URLs ready for your morning review. Nothing goes live without your approval."

### Execution Rules
- All deploys go to Vercel **preview URLs only** — never production
- Blockers get logged, not escalated (Jake is asleep)
- If a decision is needed that Jake didn't pre-answer, Jarvis makes a reasonable documented call and flags it in the morning brief
- Design suggestions auto-approved using best-match from library (Jake can revise post-build)

### Morning Brief Output
```
Overnight Summary (2026-03-10):

Built:
• [project-A] — staging ready: https://project-a-abc123.vercel.app
  Design used: Stripe colors, your card component
• [project-B] — staging ready: https://project-b-xyz456.vercel.app
  Note: chose Inter over Helvetica for body — felt cleaner for this audience

Needs a decision:
• [project-B] auth flow: went with email-only signup (no OAuth). Want to add Google?

Design library update:
• Extracted 2 new token sets from URLs you dropped in #design-elements

Reply 'ship [project-name]' to promote to production.
```

### Hard Gate
**No production deploys without explicit Jake approval.** This is hardcoded, not a setting. Overnight mode cannot override it.

---

## What This Is NOT (Scope Boundaries)

- No Gmail/Calendar integration (Wave 5)
- No Stripe/payments (future)
- No mobile app builds (out of scope)
- Template repo setup is a one-time human step (Jake creates `jarvis-template` repo)
- Vercel org/GitHub org connection is a one-time human setup step

---

## Cost Impact

| Addition | Cost |
|---|---|
| Browserbase (CSS extraction) | ~5-10 sessions/week = well within free tier (1000/mo) |
| E2B (build execution) | ~$2-5/mo depending on build frequency |
| Vercel (additional repos) | Free tier covers hobby projects; Pro ($20/mo) if >3 deploys/day |
| GitHub API | Free |
| Supabase (new table) | Free tier |
| **Net total** | **+$2-25/mo depending on build volume** |

Comfortably under $50/mo total until first customer.
