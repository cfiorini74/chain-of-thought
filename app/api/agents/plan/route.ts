import { type NextRequest, NextResponse } from 'next/server';
import { runToolCall } from '@/lib/anthropic';
import { MODELS } from '@/lib/models';
import { PLANNER_SYSTEM, DECOMPOSE_QUERY_TOOL } from '@/lib/prompts';
import type { PlanAgentRequest, PlanAgentResponse } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body: PlanAgentRequest = await request.json();
    if (
      typeof body.query !== 'string' ||
      typeof body.findings !== 'string' ||
      typeof body.rootQuery !== 'string'
    ) {
      return NextResponse.json(
        { error: 'query, findings, and rootQuery are required strings' },
        { status: 400 }
      );
    }

    const result = await runToolCall<PlanAgentResponse>({
      model: MODELS.plan,
      systemPrompt: PLANNER_SYSTEM,
      userPrompt: `Original query: ${body.rootQuery}\n\nSub-question just searched: ${body.query}\n\nFindings: ${body.findings}`,
      tool: DECOMPOSE_QUERY_TOOL,
      maxTokens: 1024,
      signal: request.signal,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
