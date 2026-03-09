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

export async function getFileContent(repo: string, filePath: string): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: filePath });
    if (Array.isArray(data) || data.type !== 'file') return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export async function listFiles(repo: string, dirPath: string): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: dirPath });
    if (!Array.isArray(data)) return [];
    return data.filter(f => f.type === 'file').map(f => f.name);
  } catch {
    return [];
  }
}

export async function createRepoFromTemplate(templateRepo: string, newName: string): Promise<void> {
  await octokit.rest.repos.createUsingTemplate({
    template_owner: OWNER,
    template_repo: templateRepo,
    owner: OWNER,
    name: newName,
    private: false,
  });
}

export async function createBranch(repo: string, branchName: string, fromBranch = 'main'): Promise<void> {
  const { data: ref } = await octokit.rest.git.getRef({
    owner: OWNER,
    repo,
    ref: `heads/${fromBranch}`,
  });
  await octokit.rest.git.createRef({
    owner: OWNER,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
}

export async function mergeBranch(repo: string, head: string, base = 'main'): Promise<void> {
  await octokit.rest.repos.merge({
    owner: OWNER,
    repo,
    base,
    head,
    commit_message: `chore: merge ${head} into ${base}`,
  });
}
