'use strict';
const Anthropic = require('@anthropic-ai/sdk');

/**
 * Translation back-ends.
 *
 * Every provider implements the same narrow contract — take a system prompt and
 * a user message, return the model's text — so the prompt, the batching and the
 * JSON handling all live once in translate.js instead of four times here.
 *
 * Model names are free text with suggestions rather than a fixed list: a
 * hardcoded list goes stale the moment a provider ships a new model.
 */

/**
 * Deep-copy a JSON schema with the given keywords removed.
 *
 * Providers disagree about the schema dialect: OpenAI's strict mode *requires*
 * `additionalProperties: false`, while Gemini rejects the keyword outright, so
 * the shared schema is adapted per provider rather than watered down for all.
 */
function stripSchemaKeys(node, keys) {
  if (Array.isArray(node)) return node.map((n) => stripSchemaKeys(n, keys));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k)) continue;
    out[k] = stripSchemaKeys(v, keys);
  }
  return out;
}

const claude = {
  id: 'claude',
  label: 'Claude',
  keyField: 'anthropicApiKey',
  needsKey: true,
  defaultModel: 'claude-opus-5',
  suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  note: 'Best quality for Mongolian',

  async complete({ apiKey, model, system, user, schema, signal }) {
    const client = new Anthropic({ apiKey });
    let res;
    try {
      res = await client.messages.create({
        model,
        max_tokens: 16000,
        // The system prompt is identical across batches, so it is worth caching.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        // Thinking bills at the output rate; translation rarely needs depth.
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: user }]
      }, { signal });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw Object.assign(new Error('Claude rate limit reached.'), { retryable: true });
      }
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude API key was rejected.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API.');
      throw new Error(`Claude request failed: ${err.message}`);
    }
    if (res.stop_reason === 'refusal') throw new Error('Claude declined the translation request.');
    const block = res.content.find((b) => b.type === 'text');
    if (!block) throw new Error('Claude returned no text.');
    return block.text;
  }
};

const gemini = {
  id: 'gemini',
  label: 'Google Gemini',
  keyField: 'geminiApiKey',
  needsKey: true,
  defaultModel: 'gemini-3.6-flash',
  suggestedModels: ['gemini-3.6-flash', 'gemini-2.0-flash'],
  note: 'Has a free tier',

  /** Ask the account which models it can use, so the list never goes stale. */
  async listModels(apiKey) {
    if (!apiKey) return [];
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''))
        // Embedding and vision-only variants are noise for a translator.
        .filter((n) => !/embed|aqa|imagen|veo/i.test(n));
    } catch {
      return [];
    }
  },

  async complete({ apiKey, model, system, user, schema, signal }) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            // Gemini's schema dialect has no additionalProperties.
            responseSchema: stripSchemaKeys(schema, ['additionalProperties']),
            temperature: 0.3
          }
        })
      }
    );
    if (res.status === 401 || res.status === 403) throw new Error('Gemini API key was rejected.');
    if (res.status === 429 || res.status === 503) {
      // The free tier limits requests per minute, and a long transcript is many
      // batches — let the dispatcher wait it out rather than failing the job.
      throw Object.assign(
        new Error('Gemini rate limit reached.'),
        { retryable: true }
      );
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
      throw new Error(`Gemini error ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    if (!text) throw new Error('Gemini returned no text.');
    return text;
  }
};

const openai = {
  id: 'openai',
  label: 'OpenAI',
  keyField: 'openaiApiKey',
  needsKey: true,
  defaultModel: 'gpt-4.1-mini',
  suggestedModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
  note: 'Pay as you go',

  async complete({ apiKey, model, system, user, schema, signal }) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'translations', strict: true, schema }
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (res.status === 401) throw new Error('OpenAI API key was rejected.');
    if (res.status === 429 || res.status === 503) {
      throw Object.assign(new Error('OpenAI rate limit reached.'), { retryable: true });
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
      throw new Error(`OpenAI error ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('OpenAI returned no text.');
    return text;
  }
};

const ollama = {
  id: 'ollama',
  label: 'Ollama (local)',
  keyField: null,
  needsKey: false,
  defaultModel: 'qwen2.5:14b',
  suggestedModels: ['qwen2.5:14b', 'qwen2.5:32b', 'gemma3:12b', 'llama3.1:8b'],
  note: 'Free and offline; quality depends on the model',
  baseUrl: 'http://localhost:11434',

  /** Ollama can report what is actually installed, so this list is live. */
  async listModels() {
    try {
      const res = await fetch(`${ollama.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  },

  async complete({ model, system, user, schema, signal }) {
    let res;
    try {
      res = await fetch(`${ollama.baseUrl}/api/chat`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: schema,
          options: { temperature: 0.3 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
    } catch {
      throw new Error('Could not reach Ollama at localhost:11434. Is it running?');
    }
    if (res.status === 404) throw new Error(`Ollama has no model named "${model}". Pull it first.`);
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const data = await res.json();
    const text = data?.message?.content ?? '';
    if (!text) throw new Error('Ollama returned no text.');
    return text;
  }
};

const PROVIDERS = { claude, gemini, openai, ollama };

module.exports = { PROVIDERS };
