import { tavilySearch } from '../lib/tavily';
import { runToolCall, runTextCall } from '../lib/anthropic';
import {
  DECOMPOSE_QUERY_TOOL,
  PLANNER_SYSTEM,
  ROLLUP_SYSTEM,
  ROLLUP_TOOL,
  SEARCH_SYNTHESIS_SYSTEM,
} from '../lib/prompts';
import type { Claim, ClaimSource, RawClaim, RawClaimSource } from '../lib/types';

const ROOT_QUERY =
  'Build an investment thesis for MSFT covering Azure growth, AI capex ROI, valuation vs peers, and competitive moat';

async function searchAgent(query: string) {
  console.log(`\n[search] ${query}`);
  const results = await tavilySearch(query);
  const numbered = results
    .map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content.slice(0, 4000)}`)
    .join('\n\n');
  const findings = await runTextCall({
    model: 'claude-sonnet-4-6',
    systemPrompt: SEARCH_SYNTHESIS_SYSTEM,
    userPrompt: `You are researching: ${query}\n\nSearch results:\n${numbered}`,
    maxTokens: 2500,
  });
  console.log(`[search] findings (${findings.length} chars, ${results.length} sources)`);
  return { results, findings };
}

async function plannerAgent(query: string, findings: string, rootQuery: string) {
  console.log(`\n[plan] ${query}`);
  const result = await runToolCall<{ decompose: boolean; subquestions: string[] }>({
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: PLANNER_SYSTEM,
    userPrompt: `Original query: ${rootQuery}\n\nSub-question just searched: ${query}\n\nFindings: ${findings}`,
    tool: DECOMPOSE_QUERY_TOOL,
    maxTokens: 1024,
  });
  console.log(
    `[plan] decompose=${result.decompose}, subquestions=${result.subquestions.length}`
  );
  return result;
}

async function rollupAgent(
  ownFindings: string,
  childRollups: { childId: string; summary: string; claims: Claim[] }[]
) {
  console.log(`\n[rollup] ${childRollups.length} children`);
  const indexToChildId = new Map<number, string | null>();
  indexToChildId.set(0, null);
  childRollups.forEach((cr, i) => indexToChildId.set(i + 1, cr.childId));

  const branchesText = childRollups
    .map((cr, i) => {
      const claimsText =
        cr.claims.length === 0
          ? '   (no claims)'
          : cr.claims
              .map(
                (c, j) =>
                  `   ${j + 1}. [${c.topic}] "${c.statement}"`
              )
              .join('\n');
      return `[Branch ${i + 1}]\nSummary: ${cr.summary}\nExisting claims:\n${claimsText}`;
    })
    .join('\n\n');

  const raw = await runToolCall<{ summary: string; claims: RawClaim[] }>({
    model: 'claude-opus-4-7',
    systemPrompt: ROLLUP_SYSTEM,
    userPrompt: `This node's own findings:\n${ownFindings}\n\nChild branches:\n${branchesText}`,
    tool: ROLLUP_TOOL,
    maxTokens: 3072,
  });

  const claims: Claim[] = raw.claims.map((c) => ({
    topic: c.topic,
    statement: c.statement,
    supporting: c.supporting.map((s) => translate(s, indexToChildId)),
    opposing: c.opposing.map((s) => translate(s, indexToChildId)),
  }));

  console.log(
    `[rollup] summary (${raw.summary.length} chars), ${claims.length} claims`
  );
  return { summary: raw.summary, claims };
}

function translate(
  raw: RawClaimSource,
  indexToChildId: Map<number, string | null>
): ClaimSource {
  return {
    childId: indexToChildId.get(raw.branchIndex) ?? null,
    quote: raw.quote,
  };
}

function describeSrc(
  sources: ClaimSource[],
  children: { id: string; query: string }[]
): string {
  if (sources.length === 0) return '(none)';
  return sources
    .map((s) => {
      if (s.childId === null) return 'self';
      const child = children.find((c) => c.id === s.childId);
      return child ? `"${child.query.slice(0, 60)}"` : `unknown(${s.childId})`;
    })
    .join('; ');
}

async function main() {
  const root = await searchAgent(ROOT_QUERY);
  const plan = await plannerAgent(ROOT_QUERY, root.findings, ROOT_QUERY);

  if (!plan.decompose) {
    console.log('\nRoot did not decompose. Tree is single node.');
    console.log('\n=== ROOT FINDINGS ===\n');
    console.log(root.findings);
    return;
  }

  console.log(`\nDecomposing into ${plan.subquestions.length} children:`);
  plan.subquestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  const children: Array<{ id: string; query: string; findings: string }> = [];
  for (const sq of plan.subquestions) {
    const childId = `child-${children.length + 1}`;
    const child = await searchAgent(sq);
    children.push({ id: childId, query: sq, findings: child.findings });
  }

  const rollup = await rollupAgent(
    root.findings,
    children.map((c) => ({ childId: c.id, summary: c.findings, claims: [] }))
  );

  console.log('\n=== ROOT ROLLUP SUMMARY ===\n');
  console.log(rollup.summary);

  console.log('\n=== CLAIMS ===');
  if (rollup.claims.length === 0) {
    console.log('(none extracted)');
  } else {
    rollup.claims.forEach((c, i) => {
      console.log(`\n${i + 1}. [${c.topic}]`);
      console.log(`   "${c.statement}"`);
      console.log(`   Supporting: ${describeSrc(c.supporting, children)}`);
      console.log(`   Opposing: ${describeSrc(c.opposing, children)}`);
    });
  }

  const contradicted = rollup.claims.filter((c) => c.opposing.length > 0);
  console.log(
    `\n${contradicted.length} of ${rollup.claims.length} claims are contradicted (opposing.length > 0).`
  );
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
