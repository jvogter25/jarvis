import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  '/app/agency-agents',                                          // Railway absolute
  path.join(__dirname, '../../agency-agents'),                   // dist/agents -> app root
  path.join(__dirname, '../../../agency-agents'),                // dist/agents -> one above
  path.join(process.cwd(), 'agency-agents'),                    // cwd fallback
];
const AGENTS_DIR = candidates.find(d => { try { fs.readdirSync(d); return true; } catch { return false; } }) ?? candidates[0];
console.log('AGENTS_DIR resolved:', AGENTS_DIR);

let _agents: Agent[] | null = null;

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '' };

  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);

  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  };
}

export function loadAgents(): Agent[] {
  if (_agents) return _agents;

  const agentFiles: string[] = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'README.md' && entry.name !== 'CONTRIBUTING.md') {
        agentFiles.push(fullPath);
      }
    }
  }

  walkDir(AGENTS_DIR);

  _agents = agentFiles
    .map(filePath => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { name, description } = parseFrontmatter(content);
      const slug = path.basename(filePath, '.md');
      return { id: slug, name, description, systemPrompt: content };
    })
    .filter(agent => agent.name && agent.description);

  console.log(`Loaded ${_agents.length} agents`);
  return _agents;
}
