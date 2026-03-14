import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function readGithubFile(
  owner: string,
  repo: string,
  path: string,
  branch = 'main'
): Promise<string> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    const file = response.data;
    if (Array.isArray(file)) return `${path} is a directory. Contents: ${file.map(f => f.name).join(', ')}`;
    if (file.type !== 'file' || !('content' in file)) return `Could not read ${path} — not a file.`;
    return Buffer.from(file.content, 'base64').toString('utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `read_github_file failed: ${msg}`;
  }
}

export async function listGithubFiles(
  owner: string,
  repo: string,
  path = '',
  branch = 'main'
): Promise<string> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    const entries = response.data;
    if (!Array.isArray(entries)) {
      return `${path || '/'} is a file, not a directory. Use read_github_file to read it.`;
    }
    const lines = entries.map(e => {
      const size = e.type === 'file' && 'size' in e ? ` (${e.size} bytes)` : '';
      return `${e.type === 'dir' ? '📁' : '📄'} ${e.name}${size}`;
    });
    return `Contents of ${owner}/${repo}/${path || ''}:\n${lines.join('\n')}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `list_files failed: ${msg}`;
  }
}

export async function searchGithubCode(
  owner: string,
  repo: string,
  query: string
): Promise<string> {
  try {
    const response = await octokit.rest.search.code({ q: `${query} repo:${owner}/${repo}` });
    const items = response.data.items;
    if (items.length === 0) return `No results found for "${query}" in ${owner}/${repo}`;
    const results = items.slice(0, 10).map(item => {
      const excerpts = (item.text_matches ?? [])
        .map((m: { fragment?: string }) => m.fragment ? `  > ${m.fragment.trim().split('\n')[0]}` : '')
        .filter(Boolean)
        .join('\n');
      return `📄 ${item.path}${excerpts ? '\n' + excerpts : ''}`;
    });
    return `Search results for "${query}" in ${owner}/${repo} (${items.length} total):\n\n${results.join('\n\n')}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `search_code failed: ${msg}`;
  }
}
