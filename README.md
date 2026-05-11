# Chain of Thought

Agent-driven research tool. The root question becomes a tree of sub-questions, with each branch running parallel web search and synthesis. Findings roll up into structured `Claim` objects with branch attribution. Contradictions are claims whose `opposing` source list is non-empty, surfaced in the UI alongside their supporting branches.

## Prerequisites

- Node 20+ (tested on 24)
- pnpm 9+
- Anthropic API key
- Tavily API key
- A password value for the demo login gate

## Setup

```bash
git clone https://github.com/cfiorini74/chain-of-thought.git
cd chain-of-thought
pnpm install
cp .env.local.example .env.local
```

Fill in `.env.local`:

- `ANTHROPIC_API_KEY`: your Anthropic key.
- `TAVILY_API_KEY`: your Tavily key.
- `DEMO_PASSWORD`: the password users type at the login screen.
- `AUTH_SECRET`: a 32+ byte secret for signing session cookies. Generate with:

```bash
openssl rand -base64 32
```

## Run

```bash
pnpm dev
# http://localhost:3000
```

Log in with `DEMO_PASSWORD`. Type a question on the landing screen. The root node builds first, then use Expand and Summarize on each node to grow and consolidate the tree.

## Tests

```bash
pnpm test-orchestrator   # fast; mock agents, no network
pnpm test-agents         # slow; hits Anthropic and Tavily for real
```

`test-orchestrator` is the one you'll run during development. It exercises the client orchestrator (build, expand, summarize, abort handling, exclusion propagation, stale-marking) against a mock agent layer.

## Architecture

- `app/api/agents/*`: three stateless agent endpoints (`search`, `plan`, `rollup`). Each is one LLM or Tavily call with no memory between requests.
- `app/page.tsx` + `components/ResearchApp.tsx`: gated landing and research canvas.
- `components/ResearchGraph.tsx`: React Flow canvas with d3-hierarchy layout.
- `components/NodeCard.tsx`, `components/SidePanel.tsx`: node tile and detail panel.
- `lib/orchestrator.ts`: client-side coordinator. Exposes `buildInitialTree`, `expandNode`, `summarizeSubtree`, `resetAndRebuild`, `markChainStale`.
- `lib/store.ts`: Zustand tree state. Single source of truth for the UI.
- `lib/types.ts`: `ResearchNode`, `Claim`, `ClaimSource`, agent request/response shapes.
- `lib/prompts.ts`: agent system prompts and tool schemas.
- `lib/anthropic.ts`: Anthropic SDK wrapper with tool use and prompt caching.
- `lib/tavily.ts`: Tavily search client.

Tree state lives in the client. The server runs three thin proxies. No SSE, no sessions, no JSON snapshots.

## Models

All three agents use `claude-haiku-4-5-20251001`. System prompts are cached with `cache_control: { type: 'ephemeral' }` to amortize cost across the ~20 calls per session.

Cost ceiling under the cache is around $0.50 to $0.85 per full tree run. Set an Anthropic spending limit before iterating.
