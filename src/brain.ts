import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase.js';
import { serveHtml } from './sandbox/client.js';
import { runShell } from './tools/shell.js';
import { browseUrl } from './tools/browser.js';
import { searchWeb } from './tools/search.js';
import { getInstalledTools } from './tools/registry.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Claude tool definitions (subset of installed tools that have Claude-facing APIs)
const TOOL_SCHEMAS: Record<string, Anthropic.Tool> = {
  deploy_html: {
    name: 'deploy_html',
    description: 'Deploy a complete HTML page to a live public sandbox URL. Use this whenever you produce a finished HTML page — never paste raw HTML in the chat.',
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
    description: 'Run shell commands in a sandboxed environment. Use for code execution, package installs, file processing, data transforms, etc.',
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
    description: 'Navigate to a URL with a real browser and extract page content, text, titles. Use for research, competitor analysis, audits.',
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
};

export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;  // set when deploy_html succeeds
  installRequest?: { capability: string; reason: string }; // set when install requested
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

    case 'request_tool_install': {
      const capability = input.capability as string;
      const reason = input.reason as string;
      return {
        toolName: name,
        output: `Install request noted for: ${capability}`,
        installRequest: { capability, reason },
      };
    }

    default:
      return { toolName: name, output: `Unknown tool: ${name}` };
  }
}

/**
 * Run Claude with tool support. Loops until Claude stops requesting tool calls.
 * Returns final text response + list of all tool results (for handler to act on).
 */
export async function think(
  systemPrompt: string,
  history: Message[],
  userMessage: string
): Promise<ThinkResult> {
  const installedToolIds = new Set(getInstalledTools().map(t => t.id));
  // Always include request_tool_install; add others only if installed + have env
  const activeToolSchemas: Anthropic.Tool[] = [
    TOOL_SCHEMAS.request_tool_install,
    ...Object.values(TOOL_SCHEMAS).filter(
      t => t.name !== 'request_tool_install' && installedToolIds.has(t.name)
    ),
  ];

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const allToolResults: ToolCallResult[] = [];
  let iterations = 0;
  const MAX_ITERATIONS = 10; // prevent infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools: activeToolSchemas,
      messages,
    });

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
