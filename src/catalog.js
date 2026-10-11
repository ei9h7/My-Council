// The short, curated list of models the app offers by default. Every model here supports prompt
// caching on OpenRouter. "· latest" entries are OpenRouter aliases that always point at the newest
// model in that family; the numbered ones stay fixed. Power users can switch on "any OpenRouter
// model" in Settings.

export const BRANDS = {
  claude: { name: 'Claude', maker: 'Anthropic', initial: 'C' },
  chatgpt: { name: 'ChatGPT', maker: 'OpenAI', initial: 'G' },
  gemini: { name: 'Gemini', maker: 'Google', initial: 'G' },
  grok: { name: 'Grok', maker: 'xAI', initial: 'X' },
  deepseek: { name: 'DeepSeek', maker: 'DeepSeek', initial: 'D' },
};

/** @type {Array<{id:string, brand:string, label:string, tag?:string}>} */
export const CATALOG = [
  { id: '~anthropic/claude-sonnet-latest', brand: 'claude', label: 'Sonnet · latest', tag: 'Recommended' },
  { id: '~anthropic/claude-opus-latest', brand: 'claude', label: 'Opus · latest', tag: 'Most capable' },
  { id: 'anthropic/claude-sonnet-5.5', brand: 'claude', label: 'Sonnet 5.5' },
  { id: 'anthropic/claude-sonnet-5', brand: 'claude', label: 'Sonnet 5' },
  { id: 'anthropic/claude-sonnet-4.6', brand: 'claude', label: 'Sonnet 4.6' },
  { id: 'anthropic/claude-opus-5.5', brand: 'claude', label: 'Opus 5.5' },
  { id: '~anthropic/claude-haiku-latest', brand: 'claude', label: 'Haiku · latest', tag: 'Fast & cheap' },

  { id: '~openai/gpt-sol-latest', brand: 'chatgpt', label: 'GPT Sol · latest', tag: 'Recommended' },
  { id: '~openai/gpt-astra-latest', brand: 'chatgpt', label: 'GPT Astra · latest', tag: 'Most capable' },
  { id: 'openai/gpt-6.1-sol', brand: 'chatgpt', label: 'GPT-6.1 Sol' },
  { id: 'openai/gpt-6-sol', brand: 'chatgpt', label: 'GPT-6 Sol' },
  { id: 'openai/gpt-5.6-sol', brand: 'chatgpt', label: 'GPT-5.6 Sol' },
  { id: '~openai/gpt-luna-latest', brand: 'chatgpt', label: 'GPT Luna · latest', tag: 'Fast & cheap' },

  { id: '~google/gemini-pro-latest', brand: 'gemini', label: 'Gemini Pro · latest', tag: 'Recommended' },
  { id: 'google/gemini-3.1-pro-preview', brand: 'gemini', label: 'Gemini 3.1 Pro' },
  { id: 'google/gemini-2.5-pro', brand: 'gemini', label: 'Gemini 2.5 Pro' },
  { id: '~google/gemini-flash-latest', brand: 'gemini', label: 'Gemini Flash · latest', tag: 'Fast & cheap' },

  { id: '~x-ai/grok-latest', brand: 'grok', label: 'Grok · latest', tag: 'Recommended' },
  { id: 'x-ai/grok-4.6', brand: 'grok', label: 'Grok 4.6' },
  { id: 'x-ai/grok-4.5', brand: 'grok', label: 'Grok 4.5' },

  { id: '~deepseek/deepseek-pro-latest', brand: 'deepseek', label: 'DeepSeek Pro · latest', tag: 'Cheap · no images' },
  { id: '~deepseek/deepseek-flash-latest', brand: 'deepseek', label: 'DeepSeek Flash · latest', tag: 'Cheapest' },
];

/**
 * The chair reads the finished debate once and writes a structured verdict, and merges the members'
 * clarifying questions. That is summarising, not deep reasoning, so a small fast model without
 * extended thinking does it well at a fraction of the price. Pinned (not "latest") so the verdict
 * format doesn't shift under you.
 */
export const CHAIRS = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', tag: 'Recommended — fast, cheap' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', tag: 'Fast, cheap' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', tag: 'Slower, ~20× the price' },
];
export const DEFAULT_CHAIR = CHAIRS[0].id;

export const DEFAULT_MODELS = ['~anthropic/claude-sonnet-latest', '~openai/gpt-sol-latest', '~google/gemini-pro-latest'];
export const DEFAULT_PERSONAS = ['money', 'time', 'stress'];

/**
 * Council styles. Comparing personas only works when the model is the same in every seat, otherwise
 * you can't tell whether a disagreement comes from the model or the persona, so "priorities" uses
 * one model for all three.
 */
export const MODES = {
  ais: { label: 'Different AIs', hint: 'Three different AIs, each giving its best balanced answer.' },
  priorities: { label: 'Different priorities', hint: 'One AI argues three sides: money, time and stress.' },
  mixed: { label: 'Both', hint: 'Three different AIs, each with its own priority.' },
};

export function brandOf(model) {
  const known = CATALOG.find((m) => m.id === model)?.brand;
  if (known) return known;
  const vendor = model.replace(/^~/, '').split('/')[0];
  return { anthropic: 'claude', openai: 'chatgpt', google: 'gemini', 'x-ai': 'grok', deepseek: 'deepseek' }[vendor] ?? null;
}

export function displayModel(model) {
  return (CATALOG.find((m) => m.id === model) ?? CHAIRS.find((m) => m.id === model))?.label ?? model;
}
