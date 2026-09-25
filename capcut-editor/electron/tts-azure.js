'use strict';
const fs = require('node:fs');

/**
 * Azure AI Speech text-to-speech.
 *
 * Included because its free tier is far more generous than ElevenLabs' and it
 * has Mongolian neural voices — the practical answer for high-volume dubbing
 * without paying per character.
 */

const MODELS = [
  { id: 'neural', label: 'Neural', credits: 1, note: 'Standard Azure neural voice' }
];

const host = (region) => `https://${region}.tts.speech.microsoft.com`;

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]
  );
}

async function listVoices({ apiKey, region }) {
  if (!apiKey) throw new Error('No Azure Speech key configured.');
  if (!region) throw new Error('No Azure region configured (e.g. "southeastasia").');

  const res = await fetch(`${host(region)}/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey }
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Azure Speech key or region was rejected. Check them in Settings.');
  }
  if (!res.ok) throw new Error(`Azure Speech error ${res.status}`);

  const data = await res.json();
  return data.map((v) => ({
    id: v.ShortName,
    name: `${v.LocalName || v.DisplayName} (${v.Locale})`,
    description: [v.Gender, v.VoiceType].filter(Boolean).join(' · '),
    locale: v.Locale
  }));
}

/** Azure has one neural tier; the model list is fixed. */
async function listModels() {
  return MODELS;
}

/** Azure exposes no remaining-quota endpoint; the portal owns that view. */
async function quota() {
  return null;
}

async function speak({ apiKey, region, voiceId, text, file, signal }) {
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${escapeXml(voiceId)}">${escapeXml(text)}</voice></speak>`;

  const res = await fetch(`${host(region)}/cognitiveservices/v1`, {
    method: 'POST', signal,
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
    },
    body: ssml
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('Azure Speech key or region was rejected. Check them in Settings.');
  }
  if (res.status === 429) throw new Error('Azure Speech rate limit reached. Wait and retry.');
  if (!res.ok) throw new Error(`Azure Speech error ${res.status}`);

  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

module.exports = {
  id: 'azure',
  label: 'Azure Speech',
  keyField: 'azureSpeechKey',
  needsRegion: true,
  MODELS,
  listModels,
  listVoices,
  quota,
  speak
};
