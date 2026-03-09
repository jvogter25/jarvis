import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase.js';
import { serveHtml } from './sandbox/client.js';
import { runShell } from './tools/shell.js';
import { browseUrl, interactWithPage } from './tools/browser.js';
import { searchWeb } from './tools/search.js';
import { getInstalledTools } from './tools/registry.js';

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
    description: 'Fetch and extract readable text content from a URL using Jina.ai Reader. Returns page title and markdown text. Use for reading articles, researching pages, extracting written content. CANNOT click, fill forms, inspect CSS, run JavaScript, or take screenshots — it is read-only text extraction. For interactive browser automation, use request_tool_install to ask for Playwright.',
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
  request_tool_install: {
    name: 'request_tool_install',
    description: 'Request installation of a capability you need but do not currently have. This will ask Jake for permission before installing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        capability: { type: 'string', description: 'What capability you need (e.g. "Stripe API", "Twilio SMS")' },
        reason: { type: 'string', description: 'Why you need it for this specific task' },
      },
      required: ['capability', 'reason'],
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
};

export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;  // set when deploy_html succeeds
  installRequest?: { capability: string; reason: string }; // set when install requested
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
}

export interface ThinkResult {
  text: string;
  toolResults: ToolCallResult[];
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
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

    case 'request_tool_install': {
      const capability = input.capability as string;
      const reason = input.reason as string;
      return {
        toolName: name,
        output: `Install request noted for: ${capability}`,
        installRequest: { capability, reason },
      };
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
  const { model = 'sonnet', noTools = false } = options;
  const modelId = MODEL_IDS[model];

  const activeToolSchemas: Anthropic.Tool[] = noTools ? [] : (() => {
    const installedToolIds = new Set(getInstalledTools().map(t => t.id));
    return [
      TOOL_SCHEMAS.request_tool_install,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => t.name !== 'request_tool_install' && installedToolIds.has(t.name)
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
    const response: Anthropic.Message = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      ...(activeToolSchemas.length > 0 ? { tools: activeToolSchemas } : {}),
    }) as Anthropic.Message;

    if (response.stop_reason !== 'tool_use') {
      // Done — extract text response
      const textBlock = response.content.find(b => b.type === 'text');
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
      const result = await executeTool(block.name, block.input as Record<string, unknown>);
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

  return { text: 'Tool execution limit reached.', toolResults: allToolResults };
}
