import { type NextRequest, NextResponse } from 'next/server';
import { tavilySearch } from '@/lib/tavily';
import { runTextCall } from '@/lib/anthropic';
import { MODELS } from '@/lib/models';
import { SEARCH_SYNTHESIS_SYSTEM } from '@/lib/prompts';
import type { SearchAgentRequest, SearchAgentResponse } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body: SearchAgentRequest = await request.json();
    if (!body.query || typeof body.query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const results = await tavilySearch(body.query, request.signal);

    const numbered = results
      .map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content.slice(0, 4000)}`)
      .join('\n\n');

    const findings = await runTextCall({
      model: MODELS.search,
      systemPrompt: SEARCH_SYNTHESIS_SYSTEM,
      userPrompt: `You are researching: ${body.query}\n\nSearch results:\n${numbered}`,
      maxTokens: 1500,
      signal: request.signal,
    });

    const response: SearchAgentResponse = { results, findings };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
