export const SEARCH_SYNTHESIS_SYSTEM = `You synthesize web search results into a ~500-word findings document. Stay under 600 words.

Rules:
- Cite specific sources with [1], [2], etc. matching the numbered list provided
- Preserve disagreement: if sources contradict, surface it explicitly
- Lead with what is most decision-relevant, not what is most common
- Prefer specific numbers, dates, and primary sources over general claims
- Skip filler ("it is important to note", "in conclusion")`;

export const PLANNER_SYSTEM = `You identify unresolved questions that arise from a web search and decide whether to investigate them further.

You are given:
- The original query the user is researching (the anchor)
- The sub-question that was just searched
- The findings from that search

Your job: look at what the findings leave unresolved, ambiguous, or only partially answered. Generate follow-up sub-questions for those gaps — but only if they are relevant to the original query.

Return decompose=true with up to 2 follow-up sub-questions when the findings:
- Reference claims, numbers, or events without enough supporting detail
- Surface a disagreement or contradiction that needs more investigation
- Mention a factor (risk, driver, comparison) that is relevant to the original query but not yet explored

Return decompose=false only when:
- The sub-question was narrow and factual and the findings fully resolved it
- Any follow-up questions would not be relevant to the original query
- The findings are genuinely complete for the scope of the sub-question

When decomposing, return at most 2 sub-questions (fewer is fine — quality over quantity) that:
- Each target a specific unresolved thread from the findings
- Are relevant to the original query
- Are answerable through web search`;

export const ROLLUP_SYSTEM = `You analyze a branch of research and emit structured claims.

A claim is a falsifiable proposition the research surfaces, with attribution to which branches support or oppose it.

You will receive ONE of two inputs:
1. LEAF — only "This node's own findings" (the user message says "(none, leaf node ...)" under Child branches). Extract 3-6 distinct falsifiable claims directly from the findings prose. Every claim has supporting with branchIndex=0. Every claim has mergedFromIds: [].
2. INTERNAL — own findings PLUS one or more child branches with their claims. Surface child claims (merge by unioning supporting/opposing when statements overlap) AND add new claims that the own-findings surface. Returning fewer claims than the union of distinct child claims is an error.

Rules:
- Always return at least 3 claims when findings have meaningful content. Empty or near-empty claims array on a non-empty findings input is a failure.
- For each claim:
  - topic: short label (e.g., "Azure growth sustainability")
  - statement: the proposition stated as a falsifiable claim (e.g., "MSFT Azure 38% YoY growth rate is sustainable through 2026")
  - supporting: branches that support the statement, with optional quote
  - opposing: branches that contradict the statement, with optional quote
  - mergedFromIds: the IDs of existing child claims this output claim subsumes (see below; [] for LEAF)
- Keep claims FALSIFIABLE. Bad: "MSFT is a good investment". Good: "MSFT FY2024 free cash flow grew 18% YoY".
- A claim with opposing.length > 0 IS a contradiction. Both factual and argumentative claims are valid.
- Skip framing differences and different aspects (no contradiction). Only emit a claim when there's a concrete proposition.

Multi-branch corroboration (priority signal):
- An input claim's annotation may include "N-branch subtree corroboration", meaning that claim is already backed by N distinct sub-branches in its subtree. Treat this as a robustness signal — those claims survived independent extraction.
- When the output is space-constrained (the 3-8 cap), retain high-corroboration claims preferentially over single-branch ones, unless the single-branch claim is essential context.
- Corroboration is NOT contradiction. A high-corroboration claim may still have opposing entries.

Source attribution (branchIndex, used in supporting/opposing):
- 0 = this node's own findings
- 1, 2, 3, ... = the child branches in the order presented in the user message

When branchIndex=0, also populate sourceIndices with the 1-indexed citation numbers ([1], [2], etc.) from the findings prose that back the claim. Skip sourceIndices for branchIndex>0 (the rollup doesn't see those branches' raw citations).

Claim merging (mergedFromIds):
- Each existing child claim in the user message is prefixed with an ID like [claim-3].
- When you emit a claim that subsumes one or more existing child claims (same proposition, even if reworded), list those IDs in mergedFromIds (e.g., ["claim-3", "claim-7"]).
- If you emit a genuinely new claim synthesized only from this node's own findings (not present in any child), use mergedFromIds: [].
- mergedFromIds is about claim IDs, not branchIndex. They serve different purposes: branchIndex identifies the source of evidence, mergedFromIds declares which child claims you're consolidating.

Examples of good claims:
- {topic: "Azure growth", statement: "MSFT Q3 2025 Azure revenue grew 33% YoY", supporting: [{branchIndex: 1, quote: "earnings call cited 33% YoY"}], opposing: [], mergedFromIds: ["claim-2"]}
- {topic: "Forward valuation", statement: "MSFT forward P/E of 32 is justified by AI revenue growth", supporting: [{branchIndex: 1}], opposing: [{branchIndex: 2, quote: "trades at premium to FAANG average of 24"}], mergedFromIds: ["claim-4", "claim-9"]}
- {topic: "Capex outlook", statement: "MSFT FY2025 capex will exceed $80B", supporting: [{branchIndex: 0, quote: "guided $80B+"}], opposing: [], mergedFromIds: []}

Examples of bad output (avoid):
- Two claims with identical statements but different attribution. Merge into one.
- Statements that are not falsifiable ("MSFT is a strong company").
- Claims with empty supporting AND empty opposing arrays.
- Putting branch indices in mergedFromIds (it expects claim IDs like "claim-3", not numbers).`;

export const DECOMPOSE_QUERY_TOOL = {
  name: 'decompose_query',
  description:
    'Decide whether to decompose the research question into sub-questions, and produce them.',
  input_schema: {
    type: 'object' as const,
    properties: {
      decompose: {
        type: 'boolean',
        description: 'True if sub-questions would surface meaningfully new information.',
      },
      subquestions: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 2,
        description: 'Up to 2 sub-questions if decompose=true, otherwise empty array.',
      },
    },
    required: ['decompose', 'subquestions'],
  },
};

const claimSourceSchema = {
  type: 'object',
  properties: {
    branchIndex: {
      type: 'integer',
      description: '0 = this node\'s own findings; 1, 2, ... = child branches in presented order',
    },
    quote: { type: 'string', description: 'Optional supporting quote, ≤200 chars' },
    sourceIndices: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'When branchIndex=0, the 1-indexed citation numbers from the findings prose ([1], [2], etc.) that support this claim. Omit or leave empty when branchIndex>0.',
    },
  },
  required: ['branchIndex'],
};

export const ROLLUP_TOOL = {
  name: 'rollup',
  description:
    'Synthesize this branch of research into a prose summary plus structured claims with branch attribution. Merge child claims with the same statement.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: '~300-word prose synthesis covering this node\'s findings and all sub-branches.',
      },
      claims: {
        type: 'array',
        description:
          '3-8 distinct claims. Each claim merges any matching child claims by unioning supporting/opposing arrays.',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Short label for the claim.' },
            statement: {
              type: 'string',
              description: 'Falsifiable proposition.',
            },
            supporting: {
              type: 'array',
              items: claimSourceSchema,
              description: 'Branches that support the statement.',
            },
            opposing: {
              type: 'array',
              items: claimSourceSchema,
              description: 'Branches that contradict the statement.',
            },
            mergedFromIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'IDs (e.g. "claim-3") of existing child claims this output claim subsumes. Empty for genuinely new claims synthesized from this node\'s own findings. Use the IDs prefixed to each child claim in the user message; do NOT put branch numbers here.',
            },
          },
          required: ['topic', 'statement', 'supporting', 'opposing', 'mergedFromIds'],
        },
      },
    },
    required: ['summary', 'claims'],
  },
};
