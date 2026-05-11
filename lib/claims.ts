import type { Claim } from './types';

export function normalizeStatement(s: string): string {
  return s.toLowerCase().trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// Distinct child branches supporting a claim — robustness signal for claims
// that survived independent extraction across branches.
export function corroborationCount(claim: Claim): number {
  const ids = new Set<string>();
  for (const s of claim.supporting) {
    if (s.childId) ids.add(s.childId);
  }
  return ids.size;
}
