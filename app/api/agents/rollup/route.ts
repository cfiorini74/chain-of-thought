import { type NextRequest, NextResponse } from 'next/server';
import { runToolCall } from '@/lib/anthropic';
import { MODELS } from '@/lib/models';
import { ROLLUP_SYSTEM, ROLLUP_TOOL } from '@/lib/prompts';
import { corroborationCount, normalizeStatement } from '@/lib/claims';
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

// Haiku frequently returns null/undefined where the tool schema declares arrays.
function asArray<T>(x: T[] | undefined | null): T[] {
  return Array.isArray(x) ? x : [];
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

    // Fallback used when Haiku skips mergedFromIds at the root: a claim that
    // cites branch N inherits every origin that branch's claims carry.
    const branchAggregateOrigins = new Map<number, string[]>();
    body.childRollups.forEach((cr, i) => {
      const origins = new Set<string>();
      for (const cl of asArray(cr.claims)) {
        for (const oid of asArray(cl.originNodeIds)) origins.add(oid);
      }
      branchAggregateOrigins.set(i + 1, Array.from(origins));
    });

    const isLeaf = body.childRollups.length === 0;
    const inputClaimOrigins = new Map<string, string[]>();
    const branchesText = isLeaf
      ? '(none, leaf node — return 3-6 falsifiable claims drawn directly from the findings above. branchIndex=0 for every supporting entry; mergedFromIds: [] for every claim.)'
      : formatBranches(body.childRollups, inputClaimOrigins);

    const userPrompt = `This node's own findings:\n${body.ownFindings}\n\nChild branches:\n${branchesText}`;

    const raw = await runToolCall<RawRollupResponse>({
      model: MODELS.rollup,
      systemPrompt: ROLLUP_SYSTEM,
      userPrompt,
      tool: ROLLUP_TOOL,
      maxTokens: 6144,
      signal: request.signal,
    });

    const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
    let claims: Claim[] = rawClaims.map((c) =>
      resolveClaim(c, indexToChildId, inputClaimOrigins, branchAggregateOrigins)
    );

    if (claims.length === 0 && isLeaf && body.ownFindings.trim().length > 0) {
      console.warn('[rollup] LEAF returned 0 claims despite non-empty findings', {
        findingsLength: body.ownFindings.length,
        rawSummary: typeof raw.summary === 'string' ? `${raw.summary.length} chars` : typeof raw.summary,
        rawClaims: raw.claims,
      });
    }

    // If the model returned no claims but children had claims, fall back to the
    // distinct union of children's claims. Catches Haiku dropping output entirely
    // at higher tree levels.
    if (claims.length === 0 && body.childRollups.some((cr) => (cr.claims ?? []).length > 0)) {
      console.warn('[rollup] model returned 0 claims; falling back to union of child claims');
      console.warn('[rollup] raw response shape:', {
        summary: typeof raw.summary === 'string' ? `${raw.summary.length} chars` : typeof raw.summary,
        claims: Array.isArray(raw.claims) ? `array len ${raw.claims.length}` : typeof raw.claims,
        rawClaimsSample: Array.isArray(raw.claims) ? raw.claims.slice(0, 2) : raw.claims,
      });
      const seen = new Set<string>();
      const merged: Claim[] = [];
      // Rewrite source childIds to the direct child branch — originals
      // reference grandchildren the parent's UI can't resolve.
      const attributeToBranch = (sources: ClaimSource[], branchChildId: string): ClaimSource[] =>
        sources.length === 0 ? [] : [{ childId: branchChildId }];
      for (const cr of body.childRollups) {
        for (const cl of asArray(cr.claims)) {
          const key = normalizeStatement(cl.statement ?? '');
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push({
            ...cl,
            supporting: attributeToBranch(asArray(cl.supporting), cr.childId),
            opposing: attributeToBranch(asArray(cl.opposing), cr.childId),
          });
        }
      }
      claims = merged;
    }

    const response: RollupAgentResponse = {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      claims,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function translateSource(
  raw: RawClaimSource,
  indexToChildId: Map<number, string | null>
): ClaimSource | null {
  if (!raw || !indexToChildId.has(raw.branchIndex)) {
    if (raw) console.warn(`[rollup] dropping invalid branchIndex: ${raw.branchIndex}`);
    return null;
  }
  const childId = indexToChildId.get(raw.branchIndex)!;
  // sourceIndices only point at this node's own findings (branchIndex=0).
  const sourceIndices =
    childId === null
      ? asArray(raw.sourceIndices).filter((n) => Number.isInteger(n) && n >= 1)
      : [];
  return {
    childId,
    quote: raw.quote,
    ...(sourceIndices.length > 0 ? { sourceIndices } : {}),
  };
}

function translateSources(
  rawList: RawClaimSource[] | undefined,
  indexToChildId: Map<number, string | null>
): ClaimSource[] {
  return asArray(rawList)
    .map((s) => translateSource(s, indexToChildId))
    .filter((s): s is ClaimSource => s !== null);
}

function resolveClaim(
  raw: RawClaim,
  indexToChildId: Map<number, string | null>,
  inputClaimOrigins: Map<string, string[]>,
  branchAggregateOrigins: Map<number, string[]>
): Claim {
  const origins = new Set<string>();
  for (const id of asArray(raw.mergedFromIds)) {
    const found = inputClaimOrigins.get(id);
    if (!found) {
      console.warn(`[rollup] unknown mergedFromIds entry: ${id}`);
      continue;
    }
    for (const nodeId of found) origins.add(nodeId);
  }

  // Fallback: model skipped mergedFromIds but cited child branches in
  // supporting/opposing. Inherit those branches' aggregate origins.
  if (origins.size === 0) {
    const branchHits = new Set<number>();
    for (const s of [...asArray(raw.supporting), ...asArray(raw.opposing)]) {
      if (s && typeof s.branchIndex === 'number' && s.branchIndex > 0) {
        branchHits.add(s.branchIndex);
      }
    }
    if (branchHits.size > 0) {
      console.warn(
        `[rollup] mergedFromIds empty; inheriting from branches ${Array.from(branchHits).join(',')}`
      );
      for (const bi of branchHits) {
        for (const oid of branchAggregateOrigins.get(bi) ?? []) origins.add(oid);
      }
    }
  }

  return {
    topic: raw.topic ?? '',
    statement: raw.statement ?? '',
    supporting: translateSources(raw.supporting, indexToChildId),
    opposing: translateSources(raw.opposing, indexToChildId),
    originNodeIds: Array.from(origins),
  };
}

function formatBranches(
  childRollups: RollupAgentRequest['childRollups'],
  inputClaimOrigins: Map<string, string[]>
): string {
  let claimCounter = 0;
  const formatClaim = (c: Claim): string => {
    claimCounter++;
    const id = `claim-${claimCounter}`;
    inputClaimOrigins.set(id, asArray(c.originNodeIds));
    const corro = corroborationCount(c);
    const corroNote =
      corro > 1 ? `; ${corro}-branch subtree corroboration` : '';
    return `   [${id}] [${c.topic ?? ''}] "${c.statement ?? ''}" (supporting: ${describeSourceCount(asArray(c.supporting))}; opposing: ${describeSourceCount(asArray(c.opposing))}${corroNote})`;
  };
  return childRollups
    .map((cr, i) => {
      const childClaims = asArray(cr.claims);
      const claimsText =
        childClaims.length === 0
          ? '   (no claims)'
          : childClaims.map(formatClaim).join('\n');
      return `[Branch ${i + 1}]\nSummary: ${cr.summary ?? ''}\nExisting claims (from sub-research):\n${claimsText}`;
    })
    .join('\n\n');
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
