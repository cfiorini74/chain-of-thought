import type {
  Claim,
  PlanAgentRequest,
  PlanAgentResponse,
  RollupAgentRequest,
  RollupAgentResponse,
  SearchAgentRequest,
  SearchAgentResponse,
} from './types';

async function postJson<Req, Res>(
  url: string,
  body: Req,
  signal?: AbortSignal
): Promise<Res> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(
      `${url} failed: ${response.status} ${text}`
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export function callSearchAgent(
  query: string,
  signal?: AbortSignal
): Promise<SearchAgentResponse> {
  return postJson<SearchAgentRequest, SearchAgentResponse>(
    '/api/agents/search',
    { query },
    signal
  );
}

export function callPlanAgent(
  query: string,
  findings: string,
  rootQuery: string,
  signal?: AbortSignal
): Promise<PlanAgentResponse> {
  return postJson<PlanAgentRequest, PlanAgentResponse>(
    '/api/agents/plan',
    { query, findings, rootQuery },
    signal
  );
}

export function callRollupAgent(
  ownFindings: string,
  childRollups: { childId: string; summary: string; claims: Claim[] }[],
  signal?: AbortSignal
): Promise<RollupAgentResponse> {
  return postJson<RollupAgentRequest, RollupAgentResponse>(
    '/api/agents/rollup',
    { ownFindings, childRollups },
    signal
  );
}
