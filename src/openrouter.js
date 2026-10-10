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
      prompt: Number(m.pricing?.prompt ?? 0) * 1e6,
      completion: Number(m.pricing?.completion ?? 0) * 1e6,
    }))
    .sort((a, b) => b.created - a.created);
}

/** Returns a `complete` function for runCouncil, bound to an API key. */
export function makeComplete(apiKey) {
  return async function complete({ model, messages, signal, onToken }) {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'My Council',
      },
      body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }),
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
        if (chunk.usage?.cost != null) cost = chunk.usage.cost;
      }
    }
    if (!text.trim()) throw new Error(`${model}: empty response`);
    return { text, cost };
  };
}
