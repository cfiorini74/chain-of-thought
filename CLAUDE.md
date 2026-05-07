@AGENTS.md

# Research Tree project

Tech demo for an FDE interview at an LLM/agent company. Pre-recorded ~15-min video. Pitch: structured **claims** with branch attribution; contradictions are claims with `opposing.length > 0`; claims compose upward through the tree by union.

## Source of truth

- **Build plan** (long, comprehensive): `.context/attachments/pasted_text_2026-05-07_00-51-13.txt`. Read this before doing anything substantive. Covers pitch, data model, API endpoints, agent flows, prompt scaffolds, build phases, things to watch, demo script, deferred extensions.
- **README.md**: setup steps + architecture overview.

## Status

Phase 1 (Backbone) and Phase 2 (client orchestrator) are **done**. `pnpm build` is green.

- Three stateless agent endpoints work: `app/api/agents/{search,plan,rollup}/route.ts`.
- Data model is **`Claim`** (not Contradiction). See `lib/types.ts`. Claims compose upward; merging happens in the rollup endpoint.
- Client orchestrator: `lib/orchestrator.ts` exposes `buildInitialTree`, `buildNode`, `markChainStale`, `recomputeChain`.
- Zustand store: `lib/store.ts`. Use `useTreeStore` for selectors and actions.
- CLI verification: `pnpm test-agents` (requires `.env.local` with `ANTHROPIC_API_KEY` and `TAVILY_API_KEY`).
- Phase 3 (eval set) and Phase 4+ (frontend) are **not started**.

## Frontend contract (for the FE agent working on Phase 4-5)

- UI mutations that involve agent calls go through `lib/orchestrator.ts`. Don't call `lib/agents.ts` from components directly.
- Tree state: `useTreeStore((s) => s.tree)`. Single source of truth. No SSE, no server state.
- Edit-findings is **disabled** until `tree.initialBuildSettled === true`.
- Cancellation: pass an `AbortSignal` to orchestrator calls. `AbortError` is treated as user-initiated cancellation; the orchestrator does NOT flip node status to `error` on abort.
- Reshape flow (Option 3): initial build is auto, all reshape ops (deepen, manual-add-child, delete) are user-confirmed.
- Claim rendering: `node.claims[]`. A claim is "contradicted" if `opposing.length > 0`. Filter for these to show the contradicted-claims list with branch attribution.
- Citation parser: `findings` text contains `[1]`, `[2]` markers; parse and link to `node.searchResults[n-1]`. Test with edited findings (user might break markers).
- Status state machine for NodeCard pulse: `pending` → `searching` → `synthesizing` → `rolling-up` → `done` (or `error`).

Pattern:
```tsx
'use client';
import { useTreeStore } from '@/lib/store';
import { buildInitialTree, recomputeChain, markChainStale } from '@/lib/orchestrator';

const tree = useTreeStore((s) => s.tree);

async function onSubmit(query: string) {
  const controller = new AbortController();
  await buildInitialTree(query, controller.signal);
}

async function onRecompute(nodeId: string) {
  markChainStale(nodeId);
  await recomputeChain(nodeId, controller.signal);
}
```

## Don't change without re-eval

- Stateless server architecture. No SSE, sessions, or JSON snapshots.
- Tool use for structured output (planner + rollup). No JSON-parse-from-prose.
- Models: planner = `claude-haiku-4-5-20251001`, search synth = `claude-sonnet-4-6`, rollup = `claude-opus-4-7`.
- `pLimit(5)` concurrency cap.
- Prompt caching (`cache_control: { type: 'ephemeral' }`) on system prompts.

## Critical gotchas

- This is **Next.js 16** (not 14). App router unchanged but Turbopack is default in dev/build. Tailwind 4 uses `@import "tailwindcss"` in `app/globals.css`, not a config file.
- Tavily auth: `Authorization: Bearer ${TAVILY_API_KEY}` header. If 401 on first run, fall back to `api_key` field in the request body.
- Cost ceiling: ~$0.50-0.85 per full tree run with caching. Set an Anthropic spending limit before iterating.
- The orchestrator silently absorbs `AbortError`. Don't add error logging that triggers on abort.

## What's next (priority)

1. **Phase 3**: `lib/evals.ts` with 8-10 hand-built rollup test cases. Run script asserts claim counts and topic match. Iterate rollup prompt until eval passes. Recommended before frontend lands so prompts are stable.
2. **Phase 4**: frontend basic. Landing page (`app/page.tsx`), canvas (`app/research/page.tsx`), `components/ResearchGraph.tsx` (React Flow + d3-hierarchy), `components/NodeCard.tsx` with 6 status states + contradicted badge, `components/PageSummary.tsx`.
3. **Phase 5**: interactions. `components/SidePanel.tsx` (findings editor + sources + Recompute), deepen-with-review popover (Feature A), manual add child (B), delete subtree (C), claims list with contradicted highlighting, failure UI.
4. **Phase 6**: collapse/expand, focus mode. Droppable.
5. **Phase 7**: polish, README pass, recording.
