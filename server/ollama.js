// Minimal Ollama HTTP client: health, model listing/pulling, and structured (JSON-schema) chat.
import config from './config.js';

const base = () => config.ollamaUrl;
const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);

// Pull progress per model name, broadcast to the UI by the server.
export const pullState = new Map();
const pullListeners = new Set();
export const onPullProgress = (fn) => pullListeners.add(fn);

export async function health() {
  try {
    const [v, t] = await Promise.all([
      fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()),
      fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()),
    ]);
    return { ok: true, version: v.version, models: (t.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size })) };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message, models: [] };
  }
}

export async function hasModel(name) {
  const h = await health();
  return h.ok && h.models.some((m) => m.name === withTag(name));
}

export async function pullModel(name) {
  if (pullState.get(name)?.status === 'pulling') return;
  const emit = (s) => {
    pullState.set(name, s);
    pullListeners.forEach((fn) => fn(name, s));
  };
  emit({ status: 'pulling', detail: 'starting', pct: 0 });
  try {
    const res = await fetch(`${base()}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const decoder = new TextDecoder();
    let buf = '';
    let lastEmit = 0;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        const pct = msg.total ? Math.round((msg.completed / msg.total) * 100) : undefined;
        if (Date.now() - lastEmit > 500 || msg.status === 'success') {
          lastEmit = Date.now();
          emit({ status: msg.status === 'success' ? 'ready' : 'pulling', detail: msg.status, pct });
        }
      }
    }
    emit({ status: 'ready', detail: 'success', pct: 100 });
  } catch (err) {
    emit({ status: 'error', detail: err.message });
    throw err;
  }
}

/** Make sure a model is present locally, pulling it if allowed. */
export async function ensureModel(name) {
  if (!name || (await hasModel(name))) return true;
  if (!config.autoPull) throw new Error(`Model "${name}" is not installed in Ollama (auto-pull disabled).`);
  await pullModel(name);
  return true;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Model did not return valid JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Chat with structured output. `schema` is a JSON schema passed as Ollama's `format`,
 * which constrains decoding so even small models return well-formed objects.
 */
export async function chatJSON({ model, system, user, schema, images, signal, temperature = 0 }) {
  const body = {
    model,
    stream: false,
    format: schema,
    keep_alive: '30m',
    think: false,
    options: { temperature, seed: 42, num_ctx: config.numCtx },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user, ...(images?.length ? { images } : {}) },
    ],
  };
  const timeout = AbortSignal.timeout(config.llmTimeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const t0 = Date.now();
  let res = await fetch(`${base()}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: sig });
  let json = await res.json();
  // Some models reject the `think` flag; retry once without it.
  if (json.error && /think/i.test(json.error)) {
    delete body.think;
    res = await fetch(`${base()}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: sig });
    json = await res.json();
  }
  if (json.error) throw new Error(`Ollama: ${json.error}`);
  return {
    data: parseJSON(json.message?.content || ''),
    stats: {
      ms: Date.now() - t0,
      promptTokens: json.prompt_eval_count,
      outputTokens: json.eval_count,
      tokPerSec: json.eval_duration ? +(json.eval_count / (json.eval_duration / 1e9)).toFixed(1) : undefined,
    },
  };
}
