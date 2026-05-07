export type NodeStatus =
  | 'pending'
  | 'searching'
  | 'synthesizing'
  | 'rolling-up'
  | 'done'
  | 'error'
  | 'depth-limit';

export interface SearchResult {
  url: string;
  title: string;
  content: string;
}

export interface ClaimSource {
  childId: string | null;
  quote?: string;
}

export interface Claim {
  topic: string;
  statement: string;
  supporting: ClaimSource[];
  opposing: ClaimSource[];
}

export interface ResearchNode {
  id: string;
  parentId: string | null;
  query: string;
  status: NodeStatus;
  searchResults: SearchResult[];
  findings: string;
  findingsEdited: boolean;
  rollup: string;
  claims: Claim[];
  rollupStale: boolean;
  rollupIncomplete: boolean;
  childIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchTree {
  rootId: string;
  nodes: Record<string, ResearchNode>;
  initialBuildSettled: boolean;
}

export interface SearchAgentRequest {
  query: string;
}
export interface SearchAgentResponse {
  results: SearchResult[];
  findings: string;
}

export interface PlanAgentRequest {
  query: string;
  findings: string;
  rootQuery: string;
}
export interface PlanAgentResponse {
  decompose: boolean;
  subquestions: string[];
}

export interface RollupAgentRequest {
  ownFindings: string;
  childRollups: { childId: string; summary: string; claims: Claim[] }[];
}
export interface RollupAgentResponse {
  summary: string;
  claims: Claim[];
}

export interface RawClaimSource {
  branchIndex: number;
  quote?: string;
}

export interface RawClaim {
  topic: string;
  statement: string;
  supporting: RawClaimSource[];
  opposing: RawClaimSource[];
}
