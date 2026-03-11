import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase.js';
import { serveHtml } from './sandbox/client.js';
import { runShell } from './tools/shell.js';
import { browseUrl, interactWithPage } from './tools/browser.js';
import { searchWeb } from './tools/search.js';
import { getInstalledTools } from './tools/registry.js';
import { emitDashboardEvent, DashboardRoom } from './dashboard/events.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Claude tool definitions (subset of installed tools that have Claude-facing APIs)
const TOOL_SCHEMAS: Record<string, Anthropic.Tool> = {
  deploy_html: {
    name: 'deploy_html',
    description: 'Deploy a raw HTML snippet to a temporary sandbox URL for quick demos or experiments only. Do NOT use this for landing pages, SaaS products, or anything Jake wants to keep — use build_app instead. This sandbox URL expires and has no GitHub repo or Vercel project behind it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        html: { type: 'string', description: 'The complete HTML document to deploy' },
        title: { type: 'string', description: 'Short title for the page (for confirmation message)' },
      },
      required: ['html'],
    },
  },
  run_shell: {
    name: 'run_shell',
    description: 'Run shell commands in a sandboxed E2B environment. Use for code execution, data processing, file transforms, Python/Node scripts. The sandbox has Node.js and Python pre-installed but does NOT have Playwright, browser binaries, or GUI tools. Do not attempt to use Playwright or any browser automation via this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'Shell commands to run sequentially' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          description: 'Optional files to write before running commands',
        },
      },
      required: ['commands'],
    },
  },
  browse_web: {
    name: 'browse_web',
    description: 'Fetch and extract readable text content from a URL using Jina.ai Reader. Returns page title and markdown text. Use for reading articles, researching pages, extracting written content. CANNOT click, fill forms, inspect CSS, run JavaScript, or take screenshots — it is read-only text extraction. For interactive browser automation, use `self_modify_request` to add Playwright.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to visit' },
        task: { type: 'string', description: 'What to extract or analyze from the page' },
      },
      required: ['url', 'task'],
    },
  },
  search_web: {
    name: 'search_web',
    description: 'Search the web for any topic. Returns titles, URLs, and descriptions. Use this to discover relevant pages, then use browse_web to read specific pages in depth.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  playwright: {
    name: 'playwright',
    description: 'Interactive Playwright browser automation on live pages via Browserbase. Use for: clicking buttons, filling forms, inspecting CSS/computed styles, running JavaScript, testing user flows, taking screenshots. Write Playwright JS code that runs after page.goto() — use page.* methods and console.log() to return results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        playwright_code: { type: 'string', description: 'Playwright JS code to run after page.goto(). Use page.* methods. console.log() any results to return them.' },
      },
      required: ['url', 'playwright_code'],
    },
  },
  get_design_suggestions: {
    name: 'get_design_suggestions',
    description: 'Scan the design library and return available components and design tokens. ALWAYS call this before build_app to see what design elements are available to use.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Brief description of what you are building' },
      },
      required: ['description'],
    },
  },
  build_app: {
    name: 'build_app',
    description: 'Build and deploy a web project from Discord. Forks jarvis-template, injects design tokens, pushes generated Next.js files to GitHub, deploys to Vercel staging. Always call get_design_suggestions first, present a plan to Jake, and wait for approval before calling this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Human-readable project name' },
        slug: { type: 'string', description: 'URL-safe slug for GitHub repo and Vercel URL (lowercase, hyphens only)' },
        description: { type: 'string', description: 'What this builds and who it is for' },
        build_type: { type: 'string', enum: ['landing_page', 'full_app'], description: 'Type of build' },
        target_audience: { type: 'string', description: 'Who this is built for' },
        components: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of design library components to use (from get_design_suggestions)',
        },
        files: {
          type: 'array',
          description: 'Complete Next.js files to push — full file contents, ready to deploy',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to repo root, e.g. app/page.tsx' },
              content: { type: 'string', description: 'Complete file content' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['project_name', 'slug', 'description', 'build_type', 'target_audience', 'files'],
    },
  },
  preview_app: {
    name: 'preview_app',
    description: 'Preview a web project in E2B sandbox BEFORE deploying to Vercel. Use this instead of build_app when Jake wants to review before deploying, or when building for a project with limited Vercel slots. Returns a live preview URL valid for 1hr. Jake says "ship it" to trigger the full Vercel deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        build_type: { type: 'string', enum: ['landing_page', 'full_app'] },
        target_audience: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['project_name', 'slug', 'description', 'build_type', 'target_audience', 'files'],
    },
  },
  self_modify_request: {
    name: 'self_modify_request',
    description: 'Request a code change to the Jarvis codebase. ONLY call this when Jake has explicitly asked you to add, build, implement, change, fix, or install something in the codebase — using words like "add", "build", "implement", "create", "install", "fix", or "change". NEVER call this to answer a question, explain status, describe what you are doing, or respond to conversational messages. If the message is a question (starts with "what", "how", "why", "can you", "tell me", etc.) do NOT call this tool. Calling this tool asks Jake to confirm before any code is written.',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          description: 'Plain-English description of what to build or change, e.g. "add Resend email integration" or "change research loop to run every 4 hours" or "add Stripe payments tool"',
        },
      },
      required: ['intent'],
    },
  },
  search_knowledge: {
    name: 'search_knowledge',
    description: 'Search the knowledge base for relevant training material Jake has fed Jarvis. Use before writing copy (search marketing/sales), making design decisions (search design), or planning technical architecture (search engineering). Returns the most relevant insights for the current task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        domain: {
          type: 'string',
          enum: ['sales', 'marketing', 'design', 'engineering', 'product', 'growth', 'general', 'any'],
          description: 'Knowledge domain to search. Use "any" to search all domains.',
        },
        context: {
          type: 'string',
          description: 'What you are working on — used to select the most relevant insights',
        },
      },
      required: ['domain', 'context'],
    },
  },
  create_project: {
    name: 'create_project',
    description: 'Create a new project workspace — Discord category with 7 channels, GitHub repo, and isolated system prompt. Use when Jake says "create project" or approves a research opportunity for building. Ask for project name, description, and build type if not provided.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Human-readable project name, e.g. "South Bay Digital"' },
        slug: { type: 'string', description: 'URL-safe slug, lowercase hyphens only, e.g. "south-bay-digital"' },
        description: { type: 'string', description: 'One sentence describing what this project is and who it is for' },
      },
      required: ['project_name', 'slug', 'description'],
    },
  },
  draft_email: {
    name: 'draft_email',
    description: 'Compose an email on Jake\'s behalf. Pulls Jake\'s writing style from the knowledge base, writes the email in his voice, and posts it to Discord for approval before any send. Jake says "send it" to trigger the actual send.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body — write this in Jake\'s voice using the style guide' },
        context: { type: 'string', description: 'What this email is for — used to pull the most relevant style guidance' },
      },
      required: ['to', 'subject', 'body', 'context'],
    },
  },
  send_email: {
    name: 'send_email',
    description: 'Send an email from the Jarvis Gmail account. Only call this after Jake has approved a draft via the Discord approval gate. Do not call this directly without prior draft_email approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  check_inbox: {
    name: 'check_inbox',
    description: 'Check the Jarvis Gmail inbox for unread messages. Returns a summary of unread threads — who sent them, subject, and whether they are replies to emails Jarvis sent. Use when Jake asks to check email or when the inbox monitor surfaces something.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  read_tweet: {
    name: 'read_tweet',
    description: 'Fetch a tweet and its full conversation thread from Twitter/X. Accepts a tweet URL (https://twitter.com/user/status/123 or https://x.com/...) or a raw tweet ID. Returns the tweet text, author, and all replies in the thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet: { type: 'string', description: 'Tweet URL (twitter.com or x.com) or raw tweet ID' },
      },
      required: ['tweet'],
    },
  },
};

export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;  // set when deploy_html succeeds
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
  selfModifyProposal?: { plan: import('./tools/self-modify.js').SelfModifyPlan; message: string };
  selfModifyIntent?: string;  // pending confirmation — Opus not yet run
  createProjectResult?: { slug: string; generalChannelId: string; githubRepo: string };
  previewResult?: {
    slug: string;
    previewUrl: string;
    sandboxId: string;
    files: Array<{ path: string; content: string }>;
    plan: import('./tools/builder.js').BuildPlan;
  };
  emailDraftResult?: { to: string; subject: string; body: string };
}

export interface ThinkResult {
  text: string;
  toolResults: ToolCallResult[];
}

const TOOL_ROOM_MAP: Record<string, DashboardRoom> = {
  build_app: 'engineering',
  preview_app: 'engineering',
  self_modify_request: 'engineering',
  get_design_suggestions: 'design',
  search_knowledge: 'office',
  deploy_html: 'engineering',
  run_shell: 'engineering',
  browse_web: 'research',
  search_web: 'research',
  playwright: 'research',
  create_project: 'office',
  draft_email: 'inbox',
  send_email: 'inbox',
  check_inbox: 'inbox',
  read_tweet: 'research',
};

async function executeTool(name: string, input: Record<string, unknown>, notify?: (msg: string) => Promise<void>): Promise<ToolCallResult> {
  emitDashboardEvent({
    type: 'tool_call',
    room: TOOL_ROOM_MAP[name] ?? 'office',
    agent: name,
    task: typeof input.intent === 'string'
      ? (input.intent as string).slice(0, 120)
      : typeof input.description === 'string'
        ? (input.description as string).slice(0, 120)
        : JSON.stringify(input).slice(0, 120),
  });

  switch (name) {
    case 'deploy_html': {
      const html = input.html as string;
      try {
        const { url } = await serveHtml(html);
        return { toolName: name, output: `Deployed successfully to ${url}`, deployedUrl: url };
      } catch (err) {
        return { toolName: name, output: `Deploy failed: ${(err as Error).message}` };
      }
    }

    case 'run_shell': {
      const commands = input.commands as string[];
      const files = (input.files as { path: string; content: string }[]) ?? [];
      const result = await runShell(commands, files);
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
        `exit code: ${result.exitCode}`,
      ].filter(Boolean).join('\n\n');
      return { toolName: name, output };
    }

    case 'browse_web': {
      const url = input.url as string;
      const task = input.task as string;
      const result = await browseUrl(url, task);
      if (result.error) {
        return { toolName: name, output: `Browse failed: ${result.error}` };
      }
      return { toolName: name, output: `Title: ${result.title}\n\nContent:\n${result.content}` };
    }

    case 'search_web': {
      const query = input.query as string;
      const count = (input.count as number | undefined) ?? 5;
      const response = await searchWeb(query, count);
      if (response.error) {
        return { toolName: name, output: `Search failed: ${response.error}` };
      }
      const formatted = response.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join('\n\n');
      return { toolName: name, output: formatted || 'No results found.' };
    }

    case 'playwright': {
      const url = input.url as string;
      const playwrightCode = input.playwright_code as string;
      const result = await interactWithPage(url, playwrightCode);
      if (result.error) {
        return { toolName: name, output: `Playwright failed: ${result.error}` };
      }
      return { toolName: name, output: result.result };
    }

    case 'get_design_suggestions': {
      const { getDesignSuggestions } = await import('./tools/builder.js');
      const suggestions = await getDesignSuggestions(input.description as string);
      return { toolName: name, output: suggestions };
    }

    case 'build_app': {
      const { buildProject } = await import('./tools/builder.js');
      try {
        const result = await buildProject(
          {
            projectName: input.project_name as string,
            slug: input.slug as string,
            description: input.description as string,
            buildType: input.build_type as 'landing_page' | 'full_app',
            targetAudience: input.target_audience as string,
            components: input.components as string[] | undefined,
          },
          input.files as Array<{ path: string; content: string }>
        );
        return {
          toolName: name,
          output: `Build complete for **${result.slug}**\nGitHub: ${result.githubRepo}\nStaging: ${result.stagingUrl}`,
          stagingBuild: result,
        };
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[build_app] Failed:`, err);
        return { toolName: name, output: `Build failed: ${msg}` };
      }
    }

    case 'preview_app': {
      const { previewProject } = await import('./tools/builder.js');
      try {
        const plan = {
          projectName: input.project_name as string,
          slug: input.slug as string,
          description: input.description as string,
          buildType: input.build_type as 'landing_page' | 'full_app',
          targetAudience: input.target_audience as string,
        };
        const result = await previewProject(plan, input.files as Array<{ path: string; content: string }>);
        return {
          toolName: name,
          output: `Preview live for **${result.slug}**: ${result.previewUrl}\n\nURL is valid for ~1hr. Say **"ship it"** to deploy to Vercel, or tell me what to change.`,
          previewResult: { ...result, plan },
        };
      } catch (err) {
        return { toolName: name, output: `Preview failed: ${(err as Error).message}` };
      }
    }

    case 'self_modify_request': {
      // Don't run Opus yet — surface intent to handlers.ts for Jake's yes/no confirmation.
      const intent = input.intent as string;
      return {
        toolName: name,
        output: `Awaiting Jake's confirmation to implement: ${intent}`,
        selfModifyIntent: intent,
      };
    }

    case 'search_knowledge': {
      const { queryKnowledge } = await import('./tools/knowledge.js');
      const result = await queryKnowledge(
        input.domain as string,
        input.context as string
      );
      return { toolName: name, output: result };
    }

    case 'create_project': {
      const { setupProject } = await import('./tools/project-setup.js');
      const { getDiscordClient } = await import('./discord/client.js');
      const discord = getDiscordClient();
      if (!discord) {
        return { toolName: name, output: 'Discord client not available — project setup failed.' };
      }
      try {
        const result = await setupProject(
          discord,
          input.project_name as string,
          (input.slug as string).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          input.description as string
        );
        return {
          toolName: name,
          output: `Project **${input.project_name}** created!\nDiscord category ready with 7 channels.\nGitHub: ${result.githubRepo}\nStart building in <#${result.generalChannelId}>`,
          createProjectResult: {
            slug: result.slug,
            generalChannelId: result.generalChannelId,
            githubRepo: result.githubRepo,
          },
        };
      } catch (err) {
        return { toolName: name, output: `Project setup failed: ${(err as Error).message}` };
      }
    }

    case 'draft_email': {
      const { queryKnowledge } = await import('./tools/knowledge.js');
      const to = input.to as string;
      const subject = input.subject as string;
      const body = input.body as string;
      const context = input.context as string;

      const styleGuide = await queryKnowledge('email_style', context);

      const preview =
        `**To:** ${to}\n**Subject:** ${subject}\n\n${body}\n\n---\n*Style guide applied:* ${styleGuide.slice(0, 200)}`;

      return {
        toolName: name,
        output: preview,
        emailDraftResult: { to, subject, body },
      };
    }

    case 'send_email': {
      const { sendEmail } = await import('./tools/gmail.js');
      const to = input.to as string;
      const subject = input.subject as string;
      const body = input.body as string;
      try {
        await sendEmail(to, subject, body);
        return { toolName: name, output: `Sent to ${to}.` };
      } catch (err) {
        return { toolName: name, output: `Send failed: ${(err as Error).message}` };
      }
    }

    case 'check_inbox': {
      const { readInbox } = await import('./tools/gmail.js');
      try {
        const threads = await readInbox(20);
        if (threads.length === 0) {
          return { toolName: name, output: 'Inbox is clear — no unread messages.' };
        }
        const formatted = threads.map(t =>
          `• **${t.subject}**\n  From: ${t.from}\n  ${t.snippet.slice(0, 100)}${t.isReply ? ' *(reply)*' : ''}`
        ).join('\n\n');
        return { toolName: name, output: `${threads.length} unread thread(s):\n\n${formatted}` };
      } catch (err) {
        return { toolName: name, output: `Inbox check failed: ${(err as Error).message}` };
      }
    }

    case 'read_tweet': {
      const { fetchTwitterThread, formatThread } = await import('./tools/twitter.js');
      const result = await fetchTwitterThread(input.tweet as string);
      return { toolName: name, output: formatThread(result) };
    }

    default:
      return { toolName: name, output: `Unknown tool: ${name}` };
  }
}

/**
 * Run Claude with tool support. Loops until Claude stops requesting tool calls.
 * Returns final text response + list of all tool results (for handler to act on).
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export interface ThinkOptions {
  /** Model tier: haiku (fast/cheap), sonnet (default), opus (complex builds) */
  model?: ModelTier;
  /** Skip tool injection — for pure text/analysis calls like scoring */
  noTools?: boolean;
  /** Override max_tokens (default 8192). Use 32000 for large codegen responses. */
  maxTokens?: number;
  /** Live status callback — passed to long-running tools like self_modify_request */
  notify?: (msg: string) => Promise<void>;
}

/**
 * Run Claude with tool support. Loops until Claude stops requesting tool calls.
 * Returns final text response + list of all tool results (for handler to act on).
 *
 * model: 'haiku' for scoring/formatting, 'sonnet' for chat (default), 'opus' for full app builds
 * noTools: true for pure analysis calls (scorer, trainer) — skips tool schema injection
 */
export async function think(
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  options: ThinkOptions = {}
): Promise<ThinkResult> {
  const { model = 'sonnet', noTools = false, maxTokens = 8192 } = options;

  emitDashboardEvent({
    type: 'agent_active',
    room: 'office',
    agent: `brain:${model}`,
    task: userMessage.slice(0, 120),
  });
  const modelId = MODEL_IDS[model];

  const activeToolSchemas: Anthropic.Tool[] = noTools ? [] : (() => {
    const installedToolIds = new Set(getInstalledTools().map(t => t.id));
    const alwaysAvailable = ['self_modify_request', 'search_knowledge', 'create_project', 'draft_email', 'send_email', 'check_inbox'];
    return [
      TOOL_SCHEMAS.self_modify_request,
      TOOL_SCHEMAS.search_knowledge,
      TOOL_SCHEMAS.create_project,
      TOOL_SCHEMAS.draft_email,
      TOOL_SCHEMAS.send_email,
      TOOL_SCHEMAS.check_inbox,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => !alwaysAvailable.includes(t.name) && installedToolIds.has(t.name)
      ),
    ];
  })();

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const allToolResults: ToolCallResult[] = [];
  let iterations = 0;
  const MAX_ITERATIONS = 10; // prevent infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response: Anthropic.Message = await client.messages.stream({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(activeToolSchemas.length > 0 ? { tools: activeToolSchemas } : {}),
    }).finalMessage();

    if (response.stop_reason !== 'tool_use') {
      // Done — extract text response
      const textBlock = response.content.find(b => b.type === 'text');
      emitDashboardEvent({ type: 'agent_idle', room: 'office', agent: `brain:${model}` });
      return {
        text: textBlock?.type === 'text' ? textBlock.text : '',
        toolResults: allToolResults,
      };
    }

    // Execute all tool calls in this response
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input as Record<string, unknown>, options.notify);
      allToolResults.push(result);
      toolResultContent.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.output,
      });
    }

    // Feed results back to Claude
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultContent });
  }

  emitDashboardEvent({ type: 'agent_idle', room: 'office', agent: `brain:${model}` });
  return { text: 'Tool execution limit reached.', toolResults: allToolResults };
}
