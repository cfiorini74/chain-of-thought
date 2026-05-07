import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry';

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export type Model =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7';

interface ToolCallOptions {
  model: Model;
  systemPrompt: string;
  userPrompt: string;
  tool: {
    name: string;
    description: string;
    input_schema: object;
  };
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function runToolCall<T>(opts: ToolCallOptions): Promise<T> {
  const { model, systemPrompt, userPrompt, tool, maxTokens = 2048, signal } = opts;

  return withRetry(async () => {
    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema as never,
          },
        ],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal }
    );

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(
        `Expected tool_use in response, got: ${JSON.stringify(response.content)}`
      );
    }
    return toolUse.input as T;
  });
}

interface TextCallOptions {
  model: Model;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function runTextCall(opts: TextCallOptions): Promise<string> {
  const { model, systemPrompt, userPrompt, maxTokens = 2048, signal } = opts;

  return withRetry(async () => {
    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal }
    );

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error(
        `Expected text block in response, got: ${JSON.stringify(response.content)}`
      );
    }
    return textBlock.text;
  });
}
