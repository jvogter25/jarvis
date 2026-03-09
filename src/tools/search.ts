export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

/**
 * Search the web using Brave Search API.
 * Returns up to `count` results (default 5, max 20).
 * Requires BRAVE_SEARCH_API_KEY env var.
 */
export async function searchWeb(query: string, count = 5): Promise<SearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { results: [], error: 'BRAVE_SEARCH_API_KEY not set' };
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
    });

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { results: [], error: `Brave API error: ${res.status} ${res.statusText}` };
    }

    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description?: string }> };
    };

    const results: SearchResult[] = (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description ?? '',
    }));

    return { results };
  } catch (err) {
    return { results: [], error: (err as Error).message };
  }
}
