'use strict';
const { PROVIDERS } = require('./translate-providers');

/**
 * Segment translation, provider-agnostic.
 *
 * The prompt, the batching and the JSON handling live here so every back-end
 * behaves identically; a provider only has to turn a prompt into text.
 */

/**
 * Lines per request.
 *
 * Free tiers throttle *requests* per minute, not tokens, so on a long
 * transcript wall-clock time is driven almost entirely by how many round trips
 * we make. Packing more lines into each one is the main lever; 100 keeps the
 * reply well inside the output limit while cutting the request count by 2.5x
 * versus the original 40.
 */
const BATCH_SIZE = 100;

const SYSTEM = `You translate transcript segments for a dubbed video.

Rules:
- Translate into natural, spoken {LANG} — the kind a narrator would actually say aloud, not literal or bookish phrasing.
- Each segment is dubbed over a fixed slot of video, so keep the spoken length close to the original. Each input carries a "seconds" field: aim for a line that a narrator reads comfortably in about that time. Slightly shorter is better than longer.
- Preserve proper nouns, product names, and numbers.
- Keep sentences flowing across segments: a sentence split over two segments should still read as one sentence.
- Do not add commentary, notes, or anything the speaker did not say. If a segment is filler or noise, translate it as the nearest natural equivalent or return an empty string.
- Return one translation per input id, and nothing else.`;

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' }
        },
        required: ['id', 'text'],
        additionalProperties: false
      }
    }
  },
  required: ['translations'],
  additionalProperties: false
};

function provider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown translation provider: ${id}`);
  return p;
}

/** Shape the UI needs to build the provider picker. */
function describe() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    keyField: p.keyField,
    needsKey: p.needsKey,
    defaultModel: p.defaultModel,
    suggestedModels: p.suggestedModels,
    note: p.note
  }));
}

/** Live model list where the provider can report one (Gemini, Ollama). */
async function listModels(id, apiKey) {
  const p = provider(id);
  const live = p.listModels ? await p.listModels(apiKey) : [];
  return live.length ? live : p.suggestedModels;
}

const sleep = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal });

/**
 * Run one batch, waiting out rate limits rather than failing the whole job.
 * A long transcript is many batches, and free tiers throttle per minute, so
 * hitting a limit part-way through is expected rather than exceptional.
 */
async function completeWithRetry(p, args, onWait, maxAttempts = 6) {
  // Free-tier request windows reset per minute, so start well under a minute
  // and grow from there rather than idling for a fixed 20s every time.
  let delay = 10000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await p.complete(args);
    } catch (err) {
      if (args.signal?.aborted || !err.retryable || attempt >= maxAttempts) throw err;
      onWait?.({ seconds: Math.round(delay / 1000), attempt });
      await sleep(delay, args.signal);
      delay = Math.min(delay * 2, 120000);
    }
  }
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Pull the JSON object out of a model reply.
 * Providers with schema support return clean JSON, but local models in
 * particular still wrap it in prose or a code fence.
 */
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to salvage */ }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* keep trying */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* give up below */ }
  }
  throw new Error('The model did not return usable JSON.');
}

/**
 * Translate transcript segments.
 * `segments` = [{ id, start, end, text }]
 * Returns the same array with a `translated` field added.
 */
async function translateSegments(segments, opts = {}) {
  const { providerId = 'claude', apiKey, model, language = 'Mongolian', onProgress } = opts;

  const p = provider(providerId);
  if (p.needsKey && !apiKey) throw new Error(`No API key configured for ${p.label}.`);

  const usable = segments.filter((s) => s.text && s.text.trim());
  if (!usable.length) return segments.map((s) => ({ ...s, translated: '' }));

  const system = SYSTEM.replace('{LANG}', language) + (opts.glossary ? '\nUse these consistent names: ' + opts.glossary : '') + (opts.instruction ? '\n' + opts.instruction : '');
  const byId = new Map();
  const batches = chunk(usable, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const payload = batches[i].map((s) => ({
      id: s.id,
      seconds: Number((s.end - s.start).toFixed(2)),
      text: s.text.trim()
    }));

    const text = await completeWithRetry(
      p,
      {
        apiKey,
        signal: opts.signal,
        model: model || p.defaultModel,
        system,
        schema: SCHEMA,
        user:
          `Translate these ${payload.length} segments into ${language}.\n\n` +
          JSON.stringify(payload, null, 1)
      },
      (w) => onProgress?.({ batch: i + 1, batches: batches.length, waiting: w.seconds })
    );

    const parsed = extractJson(text);
    for (const t of parsed.translations || []) {
      if (typeof t.id === 'number') byId.set(t.id, String(t.text ?? ''));
    }

    onProgress?.({ batch: i + 1, batches: batches.length });
  }

  if (opts.strict && usable.some(s => !byId.get(s.id)?.trim())) throw new Error('Translation omitted a line. No audio will be generated for this batch; retry or edit its transcript.');
  return segments.map((s) => ({ ...s, translated: byId.get(s.id) ?? '' }));
}

module.exports = { translateSegments, describe, listModels, provider, extractJson };
