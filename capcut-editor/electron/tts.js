'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const elevenlabs = require('./tts-elevenlabs');
const azure = require('./tts-azure');

/** Voice providers, keyed by id. Each exposes listVoices / quota / speak. */
const PROVIDERS = { elevenlabs, azure };

function provider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown voice provider: ${id}`);
  return p;
}

/** Shape the UI needs to build the provider picker. */
function describe() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    keyField: p.keyField,
    needsRegion: p.needsRegion,
    models: p.MODELS
  }));
}

function outDir() {
  const dir = path.join(app.getPath('userData'), 'dub-audio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const listVoices = (id, creds) => provider(id).listVoices(creds);
const listModels = (id, creds) => provider(id).listModels(creds);
const quota = (id, creds) => provider(id).quota(creds);
const speak = (id, opts) => provider(id).speak(opts);
const speakWithTimestamps = (id, opts) => provider(id).speakWithTimestamps ? provider(id).speakWithTimestamps(opts) : provider(id).speak(opts);

module.exports = { PROVIDERS, describe, provider, listVoices, listModels, quota, speak, speakWithTimestamps, outDir };
