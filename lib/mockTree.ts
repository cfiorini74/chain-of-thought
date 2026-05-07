import type { Claim, ResearchNode, ResearchTree } from './types';

const NOW = Date.now();

function mockNode(partial: Partial<ResearchNode> & { id: string; query: string }): ResearchNode {
  return {
    parentId: null,
    status: 'done',
    searchResults: [],
    findings: '',
    findingsEdited: false,
    rollup: '',
    claims: [],
    rollupStale: false,
    rollupIncomplete: false,
    childIds: [],
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

const childA = mockNode({
  id: 'mock-child-a',
  parentId: 'mock-root',
  query: 'How sustainable is Azure cloud growth into 2026?',
  searchResults: [
    {
      url: 'https://example.com/a1',
      title: 'MSFT Q3 2025 earnings',
      content: 'Azure revenue grew 33% YoY in Q3 2025 driven by AI workloads...',
    },
    {
      url: 'https://example.com/a2',
      title: 'Cloud market share Q3 2025',
      content: 'Azure holds 24% commercial cloud market share, up from 22%...',
    },
  ],
  findings:
    'Azure revenue grew 33% YoY in Q3 2025 [1], driven primarily by AI infrastructure demand. Commercial cloud market share reached 24%, up from 22% the prior year [2]. Bull case: AI-driven workloads create durable revenue streams. Bear case: hyperscaler capex of $80B+ in FY24 is unsustainable without continued AI demand.',
  rollup: 'Azure shows 33% YoY revenue growth and gaining market share, but $80B capex raises sustainability questions tied to ongoing AI demand.',
  claims: [
    {
      topic: 'Azure growth rate',
      statement: 'MSFT Azure revenue grew 33% YoY in Q3 2025',
      supporting: [{ childId: null, quote: 'Q3 2025 earnings: 33% YoY' }],
      opposing: [],
    },
    {
      topic: 'AI capex sustainability',
      statement: 'Hyperscaler $80B+ FY24 capex is sustainable through FY26',
      supporting: [{ childId: null, quote: 'AI workloads create durable revenue' }],
      opposing: [{ childId: null, quote: 'Capex unsustainable without continued AI demand' }],
    },
  ],
});

const childB = mockNode({
  id: 'mock-child-b',
  parentId: 'mock-root',
  query: 'What is MSFT current valuation relative to peers and historical?',
  searchResults: [
    {
      url: 'https://example.com/b1',
      title: 'MSFT forward P/E vs FAANG',
      content: 'MSFT trades at forward P/E of 32x vs FAANG average of 24x...',
    },
  ],
  findings:
    'MSFT trades at forward P/E of 32x [1], a premium to FAANG average of 24x. Bull view: AI growth justifies multiple expansion. Bear view: valuation is stretched and reverts to mean if AI growth disappoints.',
  rollup: 'MSFT forward P/E of 32x is at a premium to peers; multiple expansion bet on AI growth continuation.',
  claims: [
    {
      topic: 'Forward valuation',
      statement: 'MSFT forward P/E of 32x is justified by AI revenue growth',
      supporting: [{ childId: null, quote: 'AI growth justifies multiple' }],
      opposing: [{ childId: null, quote: 'valuation stretched, reverts to mean' }],
    },
  ],
});

const root = mockNode({
  id: 'mock-root',
  parentId: null,
  query: "Is MSFT a good investment in today's day and age?",
  searchResults: [],
  findings:
    'MSFT is the largest software company by revenue, with strong positions in cloud (Azure), productivity (M365), and gaming (Activision). The thesis turns on AI commercialization through Azure and Copilot.',
  rollup:
    'MSFT investment thesis hinges on Azure growth and AI commercialization. Bulls cite 33% Azure YoY growth and AI revenue inflection; bears cite forward P/E of 32x (premium to peers) and $80B+ capex unsustainability if AI demand falters.',
  claims: [
    {
      topic: 'Azure growth rate',
      statement: 'MSFT Azure revenue grew 33% YoY in Q3 2025',
      supporting: [{ childId: 'mock-child-a' }],
      opposing: [],
    },
    {
      topic: 'AI capex sustainability',
      statement: 'Hyperscaler $80B+ FY24 capex is sustainable through FY26',
      supporting: [{ childId: 'mock-child-a', quote: 'AI workloads durable' }],
      opposing: [{ childId: 'mock-child-a', quote: 'unsustainable without AI demand' }],
    },
    {
      topic: 'Forward valuation',
      statement: 'MSFT forward P/E of 32x is justified by AI growth',
      supporting: [{ childId: 'mock-child-b' }],
      opposing: [{ childId: 'mock-child-b', quote: 'valuation stretched' }],
    },
  ],
  childIds: ['mock-child-a', 'mock-child-b'],
});

export const mockTree: ResearchTree = {
  rootId: root.id,
  initialBuildSettled: true,
  nodes: {
    [root.id]: root,
    [childA.id]: childA,
    [childB.id]: childB,
  },
};

export function loadMockTreeIntoStore(): void {
  if (typeof window === 'undefined') return;
  import('./store').then(({ useTreeStore }) => {
    useTreeStore.setState({ tree: mockTree });
  });
}
