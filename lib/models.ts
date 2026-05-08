import type { Model } from './anthropic';

const HAIKU: Model = 'claude-haiku-4-5-20251001';
const SONNET: Model = 'claude-sonnet-4-6';
const OPUS: Model = 'claude-opus-4-7';

const isProd = process.env.NODE_ENV === 'production';

export const MODELS: { plan: Model; search: Model; rollup: Model } = {
  plan: HAIKU,
  search: isProd ? SONNET : HAIKU,
  rollup: isProd ? OPUS : HAIKU,
};
