import type { Model } from './anthropic';

const HAIKU: Model = 'claude-haiku-4-5-20251001';

export const MODELS: { plan: Model; search: Model; rollup: Model } = {
  plan: HAIKU,
  search: HAIKU,
  rollup: HAIKU,
};
