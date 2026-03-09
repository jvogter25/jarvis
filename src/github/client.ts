import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;

export async function listRepos() {
  const { data } = await octokit.rest.repos.listForAuthenticatedUser({ per_page: 30 });
  return data.map(r => ({ name: r.name, url: r.html_url, private: r.private }));
}

export async function upsertFile(repo: string, filePath: string, content: string, message: string) {
  let sha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: filePath });
    if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
  } catch {
    // File doesn't exist yet
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    sha,
  });
}

export async function createPR(repo: string, title: string, body: string, head: string, base = 'main') {
  const { data } = await octokit.rest.pulls.create({
    owner: OWNER,
    repo,
    title,
    body,
    head,
    base,
  });
  return data.html_url;
}
