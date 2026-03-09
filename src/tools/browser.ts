export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  error?: string;
}

/**
 * Fetch and extract readable content from a URL using Jina.ai Reader.
 * No API key, no sandbox, no browser install — just clean text from any URL.
 * task: natural-language description of what to extract (logged for context).
 */
export async function browseUrl(url: string, task: string): Promise<BrowseResult> {
  console.log(`browseUrl: ${task} — ${url}`);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return { url, title: '', content: '', error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const text = await res.text();
    // Jina returns "Title: ...\nURL Source: ...\n\nMarkdown Content:\n..."
    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? '';
    // Strip Jina header lines, keep the content body (cap at 8000 chars)
    const content = text.replace(/^(Title:|URL Source:|Markdown Content:)[^\n]*\n/gm, '').trim().slice(0, 8000);

    return { url, title, content };
  } catch (err) {
    return { url, title: '', content: '', error: (err as Error).message };
  }
}
