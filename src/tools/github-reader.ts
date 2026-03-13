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
