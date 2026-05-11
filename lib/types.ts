export type NodeStatus =
  | 'pending'
  | 'searching'
  | 'synthesizing'
  | 'rolling-up'
  | 'done'
  | 'error';

export interface SearchResult {
  url: string;
  title: string;
  content: string;
}

export interface ClaimSource {
  childId: string | null;
  quote?: string;
  // 1-indexed citations into the OWNER node's searchResults when childId is
  // null (own findings). When childId !== null, these reference the CHILD's
  // sources and are only meaningful via origin-node navigation.
  sourceIndices?: number[];
}

export interface Claim {
  topic: string;
  statement: string;
  supporting: ClaimSource[];
  opposing: ClaimSource[];
  // Node IDs where this claim ultimately originates. Computed by walking
  // mergedFromIds through child claims at rollup time.
  originNodeIds: string[];
}

export interface ResearchNode {
  id: string;
  parentId: string | null;
  query: string;
  status: NodeStatus;
  searchResults: SearchResult[];
  findings: string;
  rollup: string;
  claims: Claim[];
  rollupStale: boolean;
  rollupIncomplete: boolean;
  // Normalized (lowercase + trimmed) claim statements the user has X'd off.
  // Filtered out when this node's claims feed into a parent's rollup.
  excludedStatements: string[];
  // Per-claim refs for exclusions in the subtree that haven't been applied
  // by a Summarize at this level. Purely for symmetric stale-tracking.
  pendingExclusions: PendingExclusion[];
  childIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PendingExclusion {
  sourceId: string;
  statement: string; // normalized
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
  sourceIndices?: number[];
}

export interface RawClaim {
  topic: string;
  statement: string;
  supporting: RawClaimSource[];
  opposing: RawClaimSource[];
  mergedFromIds: string[];
}
