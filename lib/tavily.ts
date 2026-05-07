import { withRetry } from './retry';
import type { SearchResult } from './types';

interface TavilyResult {
  url: string;
  title: string;
  content: string;
  raw_content?: string | null;
  score?: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  query: string;
  answer?: string;
}

export async function tavilySearch(
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  return withRetry(async () => {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`Tavily error ${response.status}: ${body}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    const data: TavilyResponse = await response.json();
    return data.results.map((r) => ({
      url: r.url,
      title: r.title,
      content: r.raw_content ?? r.content,
    }));
  });
}
