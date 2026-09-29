'use strict';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const cleanModel = value => String(value || '').trim().replace(/^models\//, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function quotaInfo(error, headers) {
  const message = String(error?.message || '');
  const details = Array.isArray(error?.details) ? error.details : [];
  const violations = details.flatMap(d => Array.isArray(d.violations) ? d.violations : []);
  // Only a model-scoped zero allocation permits trying another listed model.
  // Ordinary RPM/TPM exhaustion must wait, not hop between models.
  const zeroModelQuota = violations.some(v => String(v.quotaValue) === '0' && v.quotaDimensions?.model) ||
    /limit:\s*0(?:\.0+)?\s*,\s*model:\s*\S+/i.test(message);
  const daily = violations.some(v => /perday|per_day/i.test(`${v.quotaId || ''} ${v.quotaMetric || ''}`));
  const delays = details.map(d => /^([\d.]+)s$/.exec(String(d.retryDelay || ''))).filter(Boolean).map(m => Number(m[1]) * 1000);
  const textDelay = /retry in\s+([\d.]+)s/i.exec(message);
  if (textDelay) delays.push(Number(textDelay[1]) * 1000);
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter) delays.push(/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
  const tokenLimits = violations.filter(v => /input.*token|token.*input/i.test(v.quotaMetric || '') && !/perday|per_day/i.test(v.quotaId || '')).map(v => Number(v.quotaValue));
  const textLimit = /input_token_count[^]*?limit:\s*(\d+)/i.exec(message);
  if (textLimit) tokenLimits.push(Number(textLimit[1]));
  const positiveLimits = tokenLimits.filter(n => Number.isFinite(n) && n > 0);
  return { zeroModelQuota: Boolean(zeroModelQuota), daily, tokenLimit: positiveLimits.length ? Math.min(...positiveLimits) : null, retryMs: Math.max(0, ...delays.filter(Number.isFinite)) };
}

// One client per Auto-Cut job: discover once, then remember the working model
// and unavailable models across all caption batches.
async function createRecapGemini({ apiKey, model, progress, fetchImpl = fetch, wait = sleep, now = Date.now }) {
  const redact = value => String(value || '').split(apiKey).join('[redacted]');
  const usage = new Map();
  async function cooldown(ms, message) {
    let remaining = Math.ceil(ms);
    while (remaining > 0) {
      progress?.({ stage: 'mapping', message: `${message}: ${Math.ceil(remaining / 1000)} секунд… Дууссан багцууд хадгалагдсан.` });
      const step = Math.min(5000, remaining);
      await wait(step);
      remaining -= step;
    }
  }
  async function reserve(url, tokens) {
    if (!tokens) return null;
    const state = usage.get(url) || { budget: 200000, requests: [] };
    usage.set(url, state);
    // A conservative local budget, refined by the server's actual quota on 429.
    // Real promptTokenCount replaces the estimate after successful requests.
    state.requests = state.requests.filter(r => now() - r.time < 65000);
    while (state.requests.length && state.requests.reduce((sum, r) => sum + r.tokens, 0) + tokens > state.budget) {
      await cooldown(Math.max(1, 65000 - (now() - state.requests[0].time)), 'Gemini токены лимитэд багтаахын тулд хүлээж байна');
      state.requests = state.requests.filter(r => now() - r.time < 65000);
    }
    const record = { time: now(), tokens };
    state.requests.push(record);
    return record;
  }
  async function request(url, options, tokens = 0) {
    for (let attempt = 0; attempt < 6; attempt++) {
      let response;
      const record = await reserve(url, tokens);
      try {
        response = await fetchImpl(url, {
          ...options,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(90000)
        });
      } catch (err) {
        if (attempt >= 2) throw new Error(`Gemini холболт амжилтгүй: ${redact(err.message)}`);
        await wait(1500 * (attempt + 1));
        continue;
      }
      if (response.ok) {
        const body = await response.json();
        const actual = body?.usageMetadata?.promptTokenCount;
        if (record && Number.isFinite(actual) && actual > 0) record.tokens = actual;
        return body;
      }
      let apiError = {};
      try { apiError = (await response.json())?.error || {}; } catch { /* Non-JSON error. */ }
      const detail = apiError.message || '';
      const quota = quotaInfo(apiError, response.headers);
      if (response.status === 429 && quota.tokenLimit && usage.has(url)) usage.get(url).budget = Math.floor(quota.tokenLimit * 0.8);
      const retryable = (response.status === 429 && !quota.zeroModelQuota && !quota.daily) || response.status >= 500;
      const hint = response.status === 401 || response.status === 403
        ? ' Settings дотор Gemini API key болон API эрхээ шалгана уу.'
        : response.status === 429 ? ' Gemini хүсэлтийн лимит эсвэл quota хүрсэн байна.' : '';
      const error = Object.assign(new Error(`Gemini хүсэлт амжилтгүй (HTTP ${response.status}).${hint}${detail ? ` ${redact(detail)}` : ''}`), { status: response.status, zeroModelQuota: response.status === 429 && quota.zeroModelQuota });
      if (response.status === 429 && quota.daily && !quota.zeroModelQuota) error.message = 'Gemini-ийн өдрийн quota дууссан (HTTP 429). AI Studio дотор quota шинэчлэгдэх хугацааг шалгаад дахин оролдоно уу.';
      // Bound automatic waiting, but never retry earlier than the server permits.
      const tokenThrottle = response.status === 429 && quota.tokenLimit;
      const delay = Math.max(quota.retryMs, tokenThrottle ? 65000 : response.status === 429 ? 30000 * (attempt + 1) : 1500 * (attempt + 1));
      const maxRetries = tokenThrottle ? 5 : 2;
      if (!retryable || attempt >= maxRetries || delay > 120000) throw error;
      await cooldown(delay, `Gemini HTTP ${response.status}: дахин оролдоно (${attempt + 1}/${maxRetries})`);
    }
  }

  progress?.({ stage: 'mapping', message: 'Gemini-ийн боломжит загваруудыг шалгаж байна…' });
  const available = [];
  let pageToken;
  do {
    const url = new URL(`${BASE}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await request(url.toString(), { method: 'GET' });
    for (const entry of data.models || []) {
      const name = cleanModel(entry.name);
      if (entry.supportedGenerationMethods?.includes('generateContent') &&
          /^gemini-/.test(name) && !/image|tts|audio|live|robotics|computer-use|deep-research|embedding/i.test(name)) available.push(name);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  const preferred = cleanModel(model);
  // Prefer stable Flash Lite for bulk alignment: the user's quota dashboard
  // gives Lite 500 requests/day versus 20 for Flash (a full job needs 37).
  // Discovery proves availability, not remaining quota. Retain explicit choices
  // and all existing quota/error handling; never invent model version numbers.
  const flash = available.filter(name => name.includes('flash')).sort((a, b) =>
    Number(!/^gemini-\d+(?:\.\d+)*-flash(?:-lite)?(?:-\d+)?$/.test(a)) - Number(!/^gemini-\d+(?:\.\d+)*-flash(?:-lite)?(?:-\d+)?$/.test(b)) ||
    Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) ||
    Number(!/-flash-lite(?:-|$)/.test(a)) - Number(!/-flash-lite(?:-|$)/.test(b)) ||
    b.localeCompare(a, 'en', { numeric: true }));
  const candidates = [...new Set([...(available.includes(preferred) ? [preferred] : []), ...flash])];
  if (!candidates.length) throw new Error('Gemini Auto-Cut-д ашиглах текстийн загвар олдсонгүй. Settings дотор Gemini API key болон загварын эрхээ шалгана уу.');
  let activeModel;
  let lastMissing;
  const zeroQuotaModels = new Set();
  const unavailable = new Set();
  async function generate(prompt) {
    for (const candidate of [...new Set([activeModel, ...candidates].filter(Boolean))]) {
      if (unavailable.has(candidate)) continue;
      try {
        const body = await request(`${BASE}/models/${encodeURIComponent(candidate)}:generateContent`, {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 }
          })
        }, Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3));
        if (activeModel !== candidate) progress?.({ stage: 'mapping', message: `Gemini загвар: ${candidate}` });
        activeModel = candidate;
        return body;
      } catch (err) {
        // Zero quota means this model cannot run for this project. Do not retry
        // it, but allow another advertised text model with its own allocation.
        if (err.status !== 404 && !err.zeroModelQuota) throw err;
        unavailable.add(candidate);
        if (err.zeroModelQuota) {
          zeroQuotaModels.add(candidate);
          progress?.({ stage: 'mapping', message: `${candidate}: quota 0, дараагийн боломжит загварыг шалгаж байна…` });
        } else lastMissing = err;
      }
    }
    if (zeroQuotaModels.size) throw new Error(`Gemini Auto-Cut-д ашиглах quota-тай загвар олдсонгүй (HTTP 429). ${[...zeroQuotaModels].join(', ')}: quota 0. AI Studio → Usage / Rate limits дотор төслийн quota болон billing тохиргоог шалгана уу. Timeline өөрчлөгдөөгүй.`);
    throw new Error(`Gemini-ийн жагсаасан загварууд generateContent хүсэлтийг хүлээн авсангүй. ${lastMissing?.message || ''}`);
  }
  return { generate };
}

module.exports = { createRecapGemini };
