import { type NextRequest, NextResponse } from 'next/server';
import { runToolCall } from '@/lib/anthropic';
import { MODELS } from '@/lib/models';
import { ROLLUP_SYSTEM, ROLLUP_TOOL } from '@/lib/prompts';
import type {
  Claim,
  ClaimSource,
  RawClaim,
  RawClaimSource,
  RollupAgentRequest,
  RollupAgentResponse,
} from '@/lib/types';

interface RawRollupResponse {
  summary: string;
  claims: RawClaim[];
}

export async function POST(request: NextRequest) {
  try {
    const body: RollupAgentRequest = await request.json();
    if (
      typeof body.ownFindings !== 'string' ||
      !Array.isArray(body.childRollups)
    ) {
      return NextResponse.json(
        { error: 'ownFindings (string) and childRollups (array) are required' },
        { status: 400 }
      );
    }

    const indexToChildId = new Map<number, string | null>();
    indexToChildId.set(0, null);
    body.childRollups.forEach((cr, i) => indexToChildId.set(i + 1, cr.childId));

    const branchesText = body.childRollups
      .map((cr, i) => {
        const claimsText =
          cr.claims.length === 0
            ? '   (no claims)'
            : cr.claims
                .map(
                  (c, j) =>
                    `   ${j + 1}. [${c.topic}] "${c.statement}" (supporting: ${describeSourceCount(c.supporting)}; opposing: ${describeSourceCount(c.opposing)})`
                )
                .join('\n');
        return `[Branch ${i + 1}]\nSummary: ${cr.summary}\nExisting claims (from sub-research):\n${claimsText}`;
      })
      .join('\n\n');

    const userPrompt = `This node's own findings:\n${body.ownFindings}\n\nChild branches:\n${branchesText}`;

    const raw = await runToolCall<RawRollupResponse>({
      model: MODELS.rollup,
      systemPrompt: ROLLUP_SYSTEM,
      userPrompt,
      tool: ROLLUP_TOOL,
      maxTokens: 3072,
      signal: request.signal,
    });

    const claims: Claim[] = raw.claims.map((c) => ({
      topic: c.topic,
      statement: c.statement,
      supporting: c.supporting.map((s) => translateSource(s, indexToChildId)),
      opposing: c.opposing.map((s) => translateSource(s, indexToChildId)),
    }));

    const response: RollupAgentResponse = { summary: raw.summary, claims };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function translateSource(
  raw: RawClaimSource,
  indexToChildId: Map<number, string | null>
): ClaimSource {
  if (!indexToChildId.has(raw.branchIndex)) {
    throw new Error(`Invalid branchIndex: ${raw.branchIndex}`);
  }
  return {
    childId: indexToChildId.get(raw.branchIndex)!,
    quote: raw.quote,
  };
}

function describeSourceCount(sources: ClaimSource[]): string {
  if (sources.length === 0) return 'none';
  const fromOwn = sources.filter((s) => s.childId === null).length;
  const fromSub = sources.length - fromOwn;
  const parts: string[] = [];
  if (fromOwn > 0) parts.push(`${fromOwn} from this branch's own findings`);
  if (fromSub > 0) parts.push(`${fromSub} from sub-branches`);
  return parts.join(', ');
}
