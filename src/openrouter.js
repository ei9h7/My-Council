// Thin OpenRouter client: streaming chat completions plus the public model list.

const API = 'https://openrouter.ai/api/v1';

export async function listModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
  const { data } = await res.json();
  return data
    .filter((m) => (m.architecture?.output_modalities ?? ['text']).includes('text'))
    .map((m) => ({
      id: m.id,
      name: m.name,
      created: m.created,
      vision: (m.architecture?.input_modalities ?? []).includes('image'),
      prompt: Number(m.pricing?.prompt ?? 0) * 1e6,
      completion: Number(m.pricing?.completion ?? 0) * 1e6,
      cacheRead: Number(m.pricing?.input_cache_read ?? 0) * 1e6,
      cacheWrite: Number(m.pricing?.input_cache_write ?? 0) * 1e6,
      // A listed cache-read price is how OpenRouter says the model supports prompt caching.
      caching: Number(m.pricing?.input_cache_read ?? 0) > 0,
      efforts: m.reasoning?.supported_efforts ?? [],
    }))
    .sort((a, b) => b.created - a.created);
}

/** Checks a key and returns its credit status: {label, usage, limit, limit_remaining}. */
export async function checkKey(apiKey) {
  const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401 || res.status === 403) throw new Error('OpenRouter rejected that key.');
  if (!res.ok) throw new Error(`Couldn't check the key (HTTP ${res.status}).`);
  return (await res.json()).data ?? {};
}

/**
 * Claude needs an explicit opt-in to cache; OpenAI, Gemini, Grok and DeepSeek cache automatically.
 * Anthropic's automatic mode (one top-level cache_control) moves the breakpoint forward as the
 * conversation grows, which is exactly the shape of a debate round.
 */
export const needsCacheOptIn = (model) => /^~?anthropic\//.test(model);

/** The request body for one call. Exported for tests. */
export function requestBody({ model, messages, session, effort }) {
  const body = { model, messages, stream: true, usage: { include: true } };
  // Keeps every round of one member on the same provider, so its cache is still there next round.
  if (session) body.session_id = session;
  if (needsCacheOptIn(model)) body.cache_control = { type: 'ephemeral' };
  if (effort) body.reasoning = { effort };
  return body;
}

/**
 * Returns a `complete` function for runCouncil.
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]   an OpenRouter key (self-hosted mode)
 * @param {string} [opts.endpoint] chat completions URL; defaults to OpenRouter's. The hosted build points this at its proxy.
 * @param {() => Promise<string>} [opts.getToken] bearer token per call, used instead of apiKey (e.g. a Firebase ID token)
 * @param {(id:string) => {prompt:number, cacheRead:number, cacheWrite:number}|undefined} [opts.pricing]
 *        per-million prices, used to work out caching savings when the provider doesn't report them
 */
export function makeComplete({ apiKey, endpoint = `${API}/chat/completions`, getToken, pricing } = {}) {
  return async function complete({ model, messages, session, effort, signal, onToken }) {
    const token = getToken ? await getToken() : apiKey;
    const res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Title': 'My Council',
      },
      body: JSON.stringify(requestBody({ model, messages, session, effort })),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message ?? '';
      } catch {}
      throw new Error(`${model}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let cost;
    let usage;
    let discount;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // SSE comments / keep-alives
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(`${model}: ${chunk.error.message ?? 'stream error'}`);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
        if (chunk.usage) {
          usage = chunk.usage;
          if (usage.cost != null) cost = usage.cost;
        }
        discount = chunk.cache_discount ?? chunk.usage?.cache_discount ?? discount;
      }
    }
    if (!text.trim()) throw new Error(`${model}: empty response`);
    return { text, cost, saved: cacheSavings(usage, discount, pricing?.(model)), usage };
  };
}

/**
 * Dollars saved by prompt caching on one call: OpenRouter's own figure when it sends one, otherwise
 * worked out from the cached/written token counts and the model's prices. Negative when a call
 * only wrote to the cache (writes cost a little more than a plain read on Claude).
 */
export function cacheSavings(usage, discount, price) {
  if (typeof discount === 'number') return discount;
  const d = usage?.prompt_tokens_details;
  if (!d || !price) return 0;
  const read = d.cached_tokens ?? 0;
  const write = d.cache_write_tokens ?? 0;
  const cw = price.cacheWrite || price.prompt;
  return (read * (price.prompt - price.cacheRead) - write * (cw - price.prompt)) / 1e6;
}
