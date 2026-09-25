'use strict';
const fs = require('node:fs');

const API = 'https://api.elevenlabs.io/v1';

/**
 * ElevenLabs text-to-speech.
 *
 * The model list is fetched from the account (`listModels`) so new models show
 * up without a code change; this static list is only the offline fallback for
 * when the key is missing or the call fails.
 *
 * `flash`/`turbo` bill at half a credit per character, so the model choice is
 * the single biggest lever on the cost of a dub.
 */
const MODELS = [
  { id: 'eleven_v3', label: 'Eleven v3 (Санал болгох · 70+ хэл, амьд сэтгэл хөдлөл)', credits: 1, note: 'Шинэ v3 модель' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2', credits: 1, note: 'Туршигдсан баталгаат' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (Хэт хурдан 75ms)', credits: 0.5, note: 'Хамгийн бага хоцролт' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', credits: 0.5, note: 'Хямд, хурдан' }
];

/**
 * v3 takes a different settings shape than the v2-era models (its stability is
 * a three-way creative/natural/robust choice, not a free slider), so optional
 * tuning fields are omitted for it rather than sent and rejected.
 */
const isV3 = (modelId) => String(modelId).startsWith('eleven_v3');

async function request(pathname, apiKey, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: { 'xi-api-key': apiKey, ...(init.headers || {}) }
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.detail?.message || '';
    } catch { /* body may not be JSON */ }
    if (res.status === 401) {
      throw new Error(
        'ElevenLabs rejected the key (401).' +
          (detail ? `\n${detail}` : '') +
          '\n\nGrant the missing permission on the ElevenLabs API-key page. Note ' +
          'that listing voices and speaking are separate permissions — a key ' +
          'with only Text to Speech still dubs if you paste a voice ID.'
      );
    }
    if (res.status === 402) {
      const error = new Error(
        'ElevenLabs error 402: Free users cannot use library voices via the API.\n' +
        'Сонгосон хоолой нь нийтийн сангийнх (Voice Library) тул Free API-аар дуудах боломжгүй байна. ' +
        'Үндсэн Liam (Premade - 100% үнэгүй API) хоолойг сонгох эсвэл elevenlabs.io сайтаас үнэгүй уншуулж татаж авна уу.'
      );
      error.status = 402;
      throw error;
    }
    if (res.status === 429) {
      const error = new Error('ElevenLabs rate limit reached.');
      error.status = 429;
      error.retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      throw error;
    }
    throw new Error(`ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

const DEFAULT_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ'; // Liam (Premade - Free API compatible)

async function listVoices({ apiKey }) {
  if (!apiKey) throw new Error('No ElevenLabs API key configured.');
  const res = await request('/voices', apiKey);
  const data = await res.json();
  const voices = (data.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    description: [v.labels?.accent, v.labels?.gender, v.labels?.age].filter(Boolean).join(' · ')
  }));
  const liamIdx = voices.findIndex((v) => v.id === DEFAULT_VOICE_ID || v.name.toLowerCase().startsWith('liam'));
  if (liamIdx > -1) {
    const [def] = voices.splice(liamIdx, 1);
    voices.unshift({ ...def, id: DEFAULT_VOICE_ID, name: `⭐ Liam (Үндсэн хоолой · Free API)` });
  } else {
    voices.unshift({
      id: DEFAULT_VOICE_ID,
      name: '⭐ Liam (Үндсэн хоолой · Free API)',
      category: 'premade',
      description: 'Energetic · Young male · Social media creator'
    });
  }
  return voices;
}

/**
 * Text-to-speech models the account can actually use, straight from the API.
 * Falls back to the static list so the picker still works without a key.
 */
async function listModels({ apiKey }) {
  if (!apiKey) return MODELS;
  try {
    const res = await request('/models', apiKey);
    const data = await res.json();
    const usable = (Array.isArray(data) ? data : [])
      .filter((m) => m.can_do_text_to_speech)
      .map((m) => {
        const credits = typeof m.token_cost_factor === 'number' ? m.token_cost_factor : 1;
        const langs = Array.isArray(m.languages) ? m.languages.length : 0;
        return {
          id: m.model_id,
          label: m.name || m.model_id,
          credits,
          languages: (m.languages || []).map(l => l.language_id),
          note: [
            credits !== 1 ? `${credits}× credits` : null,
            langs ? `${langs} languages` : null
          ].filter(Boolean).join(' · ')
        };
      });
    return usable.length ? usable : MODELS;
  } catch {
    return MODELS;
  }
}

/** Remaining character quota, so the UI can warn before a long job. */
async function quota({ apiKey }) {
  try {
    const res = await request('/user/subscription', apiKey);
    const d = await res.json();
    return {
      tier: d.tier ?? 'unknown',
      used: d.character_count ?? 0,
      limit: d.character_limit ?? 0
    };
  } catch {
    return null;
  }
}

/**
 * Synthesise one line to an mp3 on disk.
 * `previousText`/`nextText` are context only — they are not spoken, but they
 * let the model carry intonation across segment boundaries.
 */
async function speak({
  apiKey,
  voiceId,
  text,
  modelId = 'eleven_multilingual_v2',
  previousText = '',
  nextText = '',
  stability = 0.5,
  similarity = 0.75,
  file,
  signal
}) {
  const targetVoiceId = voiceId || DEFAULT_VOICE_ID;
  const res = await request(
    `/text-to-speech/${targetVoiceId}?output_format=mp3_44100_128`,
    apiKey,
    {
      signal,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(
        isV3(modelId)
          ? { text, model_id: modelId }
          : {
              text,
              model_id: modelId,
              previous_text: previousText || undefined,
              next_text: nextText || undefined,
              voice_settings: { stability, similarity_boost: similarity }
            }
      )
    }
  );

  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/**
 * Synthesise speech with precise character & sentence level timestamps.
 * Uses ElevenLabs POST /text-to-speech/{voiceId}/with-timestamps
 * Returns { file, duration, sentences: [ { id, text, start, end } ] }
 */
async function speakWithTimestamps({
  apiKey,
  voiceId,
  text,
  modelId = 'eleven_multilingual_v2',
  stability = 0.5,
  similarity = 0.75,
  speed = 1.0,
  file,
  signal
}) {
  const targetVoiceId = voiceId || DEFAULT_VOICE_ID;
  const body = isV3(modelId)
    ? { text, model_id: modelId }
    : {
        text,
        model_id: modelId,
        voice_settings: {
          stability: Number(stability) || 0.5,
          similarity_boost: Number(similarity) || 0.75,
          speed: Number(speed) || 1.0
        }
      };

  const res = await request(
    `/text-to-speech/${targetVoiceId}/with-timestamps?output_format=mp3_44100_128`,
    apiKey,
    {
      signal,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const data = await res.json();
  if (!data?.audio_base64) {
    throw new Error('ElevenLabs аудио өгөгдөл буцаасангүй.');
  }

  const audioBuf = Buffer.from(data.audio_base64, 'base64');
  fs.writeFileSync(file, audioBuf);

  // Parse alignment
  const chars = data.alignment?.characters || [];
  const startTimes = data.alignment?.character_start_times_seconds || [];
  const endTimes = data.alignment?.character_end_times_seconds || [];

  // Group into sentences
  const rawSentences = text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sentences = [];
  let charIdx = 0;

  for (let sIdx = 0; sIdx < rawSentences.length; sIdx++) {
    const sText = rawSentences[sIdx];
    const sStartChar = charIdx;
    charIdx += sText.length;
    while (charIdx < chars.length && /\s/.test(chars[charIdx])) {
      charIdx++;
    }
    const sEndChar = Math.min(chars.length - 1, Math.max(sStartChar, charIdx - 1));

    const startTime = startTimes[sStartChar] ?? (sIdx === 0 ? 0 : sentences[sIdx - 1]?.end ?? 0);
    const endTime = endTimes[sEndChar] ?? (startTime + Math.max(1.5, sText.length * 0.08));

    sentences.push({
      id: sIdx,
      text: sText,
      start: Math.round(startTime * 100) / 100,
      end: Math.round(endTime * 100) / 100
    });
  }

  const totalDuration = endTimes.length ? endTimes[endTimes.length - 1] : (sentences.length ? sentences[sentences.length - 1].end : 5);

  return {
    file,
    duration: totalDuration,
    sentences
  };
}

module.exports = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  keyField: 'elevenLabsApiKey',
  needsRegion: false,
  MODELS,
  listModels,
  listVoices,
  quota,
  speak,
  speakWithTimestamps
};
