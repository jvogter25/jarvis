export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  requiresEnv?: string[];   // env vars that must be set
}

export const TOOLS: ToolDefinition[] = [
  {
    id: 'deploy_html',
    name: 'Deploy HTML',
    description: 'Deploy a complete HTML page to a live public URL via E2B sandbox',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'run_shell',
    name: 'Run Shell Commands',
    description: 'Execute arbitrary shell commands in a sandboxed environment and return output',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'browse_web',
    name: 'Browse Web',
    description: 'Navigate to any URL and extract text content, titles, and page data using a real browser',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Push files to GitHub repos, create PRs, list repositories',
    installed: true,
    requiresEnv: ['GITHUB_TOKEN'],
  },
  {
    id: 'search_web',
    name: 'Web Search',
    description: 'Search the web by query using Brave Search. Returns titles, URLs, and descriptions.',
    installed: true,
    requiresEnv: ['BRAVE_SEARCH_API_KEY'],
  },
  {
    id: 'playwright',
    name: 'Playwright Browser Automation',
    description: 'Interactive browser automation — click buttons, fill forms, inspect CSS, run JavaScript, take screenshots on live pages',
    installed: true,
    requiresEnv: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  },
];

export function getInstalledTools(): ToolDefinition[] {
  return TOOLS.filter(t => {
    if (!t.installed) return false;
    if (t.requiresEnv) {
      return t.requiresEnv.every(v => !!process.env[v]);
    }
    return true;
  });
}

export function getTool(id: string): ToolDefinition | undefined {
  return TOOLS.find(t => t.id === id);
}
