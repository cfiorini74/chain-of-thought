export const SEARCH_SYNTHESIS_SYSTEM = `You synthesize web search results into a ~1000-word findings document.

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

Return decompose=true with 3-5 follow-up sub-questions when the findings:
- Reference claims, numbers, or events without enough supporting detail
- Surface a disagreement or contradiction that needs more investigation
- Mention a factor (risk, driver, comparison) that is relevant to the original query but not yet explored

Return decompose=false only when:
- The sub-question was narrow and factual and the findings fully resolved it
- Any follow-up questions would not be relevant to the original query
- The findings are genuinely complete for the scope of the sub-question

When decomposing, return 3-5 sub-questions that:
- Each target a specific unresolved thread from the findings
- Are relevant to the original query
- Are answerable through web search`;

export const ROLLUP_SYSTEM = `You analyze a branch of research and emit structured claims.

A claim is a falsifiable proposition the research surfaces, with attribution to which branches support or oppose it. Claims compose across the tree: when a child rollup contains a claim with the same statement (or near-identical meaning), MERGE by unioning the supporting and opposing arrays. Do NOT emit duplicate claims with the same statement.

Rules:
- Extract as many claims as possible per rollup, covering distinct propositions
- For each claim:
  - topic: short label (e.g., "Azure growth sustainability")
  - statement: the proposition stated as a falsifiable claim (e.g., "MSFT Azure 38% YoY growth rate is sustainable through 2026")
  - supporting: branches that support the statement, with optional quote
  - opposing: branches that contradict the statement, with optional quote
- Keep claims FALSIFIABLE. Bad: "MSFT is a good investment". Good: "MSFT FY2024 free cash flow grew 18% YoY".
- A claim with opposing.length > 0 IS a contradiction. Both factual and argumentative claims are valid.
- Skip framing differences and different aspects (no contradiction). Only emit a claim when there's a concrete proposition.

Source attribution (branchIndex):
- 0 = this node's own findings
- 1, 2, 3, ... = the child branches in the order presented in the user message

Examples of good claims:
- {topic: "Azure growth", statement: "MSFT Q3 2025 Azure revenue grew 33% YoY", supporting: [{branchIndex: 1, quote: "earnings call cited 33% YoY"}], opposing: []}
- {topic: "Forward valuation", statement: "MSFT forward P/E of 32 is justified by AI revenue growth", supporting: [{branchIndex: 1}], opposing: [{branchIndex: 2, quote: "trades at premium to FAANG average of 24"}]}

Examples of bad output (avoid):
- Two claims with identical statements but different attribution. Merge into one.
- Statements that are not falsifiable ("MSFT is a strong company").
- Claims with empty supporting AND empty opposing arrays.`;

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
        description: '3-5 sub-questions if decompose=true, otherwise empty array.',
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
          },
          required: ['topic', 'statement', 'supporting', 'opposing'],
        },
      },
    },
    required: ['summary', 'claims'],
  },
};
