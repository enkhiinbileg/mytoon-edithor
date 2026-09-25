'use strict';
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Local settings store for API credentials.
 *
 * Secrets are encrypted with Electron's safeStorage (OS keychain / DPAPI) when
 * the platform supports it, and are never returned to the renderer or written
 * to a log — the UI only ever learns whether a key is present.
 */

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function read() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function write(next) {
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

function encrypt(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('raw:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

const SECRET_KEYS = [
  'anthropicApiKey',
  'geminiApiKey',
  'openaiApiKey',
  'elevenLabsApiKey',
  'azureSpeechKey'
];

/** Values safe to hand to the renderer: secrets collapse to a boolean. */
function readPublic() {
  const s = read();
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = SECRET_KEYS.includes(k) ? Boolean(v) : v;
  }
  for (const k of SECRET_KEYS) if (!(k in out)) out[k] = false;
  out.elevenLabsKeyPool = getKeyPoolPublic();
  return out;
}

function maskKey(plain) {
  if (!plain) return '';
  if (plain.length <= 8) return '****';
  return plain.slice(0, 7) + '...' + plain.slice(-4);
}

function getKeyPoolPublic() {
  const s = read();
  let pool = Array.isArray(s.elevenLabsKeyPool) ? s.elevenLabsKeyPool : [];
  const singleKey = decrypt(s.elevenLabsApiKey);
  if (pool.length === 0 && singleKey) {
    pool = [{
      id: 'key_primary',
      label: 'Үндсэн түлхүүр #1',
      encryptedKey: s.elevenLabsApiKey,
      maskedKey: maskKey(singleKey),
      enabled: true,
      quota: null,
      status: 'ready'
    }];
    s.elevenLabsKeyPool = pool;
    write(s);
  }
  return pool.map((item) => ({
    id: item.id,
    label: item.label || 'ElevenLabs Key',
    maskedKey: item.maskedKey || maskKey(decrypt(item.encryptedKey)),
    enabled: item.enabled !== false,
    quota: item.quota || null,
    status: item.status || 'ready'
  }));
}

function getKeyPoolDecrypted() {
  const s = read();
  let pool = Array.isArray(s.elevenLabsKeyPool) ? s.elevenLabsKeyPool : [];
  const singleKey = decrypt(s.elevenLabsApiKey);
  if (pool.length === 0 && singleKey) {
    return [{
      id: 'key_primary',
      label: 'Үндсэн түлхүүр #1',
      apiKey: singleKey,
      maskedKey: maskKey(singleKey),
      enabled: true,
      quota: null,
      status: 'ready'
    }];
  }
  return pool
    .filter((item) => item.enabled !== false)
    .map((item) => ({
      id: item.id,
      label: item.label,
      apiKey: decrypt(item.encryptedKey),
      maskedKey: item.maskedKey || maskKey(decrypt(item.encryptedKey)),
      enabled: item.enabled !== false,
      quota: item.quota || null,
      status: item.status || 'ready'
    }))
    .filter((item) => Boolean(item.apiKey));
}

function addKeyToPool(plainKey, label, quotaInfo = null) {
  const clean = String(plainKey || '').trim();
  if (!clean) throw new Error('API түлхүүр хоосон байна.');
  const s = { ...read() };
  const pool = Array.isArray(s.elevenLabsKeyPool) ? [...s.elevenLabsKeyPool] : [];

  for (const it of pool) {
    if (decrypt(it.encryptedKey) === clean) {
      throw new Error('Энэ API түлхүүр аль хэдийн бүртгэгдсэн байна.');
    }
  }

  const id = 'key_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const item = {
    id,
    label: label?.trim() || `Түлхүүр #${pool.length + 1}`,
    encryptedKey: encrypt(clean),
    maskedKey: maskKey(clean),
    enabled: true,
    quota: quotaInfo,
    status: 'ready'
  };
  pool.push(item);
  s.elevenLabsKeyPool = pool;
  if (!s.elevenLabsApiKey) {
    s.elevenLabsApiKey = item.encryptedKey;
  }
  write(s);
  return getKeyPoolPublic();
}

function removeKeyFromPool(keyId) {
  const s = { ...read() };
  let pool = Array.isArray(s.elevenLabsKeyPool) ? [...s.elevenLabsKeyPool] : [];
  pool = pool.filter((it) => it.id !== keyId);
  s.elevenLabsKeyPool = pool;
  if (pool.length > 0) {
    s.elevenLabsApiKey = pool[0].encryptedKey;
  } else {
    s.elevenLabsApiKey = '';
  }
  write(s);
  return getKeyPoolPublic();
}

function toggleKeyInPool(keyId, enabled) {
  const s = { ...read() };
  const pool = Array.isArray(s.elevenLabsKeyPool) ? [...s.elevenLabsKeyPool] : [];
  const target = pool.find((it) => it.id === keyId);
  if (target) {
    target.enabled = Boolean(enabled);
    s.elevenLabsKeyPool = pool;
    write(s);
  }
  return getKeyPoolPublic();
}

function updateKeyPoolQuota(keyId, quotaInfo, status = 'ready') {
  const s = { ...read() };
  const pool = Array.isArray(s.elevenLabsKeyPool) ? [...s.elevenLabsKeyPool] : [];
  const target = pool.find((it) => it.id === keyId);
  if (target) {
    if (quotaInfo) target.quota = quotaInfo;
    if (status) target.status = status;
    s.elevenLabsKeyPool = pool;
    write(s);
  }
}

/** Merge a patch. Secret fields are encrypted; '' clears a stored secret. */
function update(patch) {
  const s = { ...read() };
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_KEYS.includes(k)) {
      const clean = v ? String(v).trim() : '';
      s[k] = clean ? encrypt(clean) : '';
    } else {
      s[k] = v;
    }
  }
  write(s);
  return readPublic();
}

/** Main-process only. Never send the result over IPC. */
function secret(name) {
  return decrypt(read()[name]);
}

module.exports = {
  readPublic,
  update,
  secret,
  getKeyPoolPublic,
  getKeyPoolDecrypted,
  addKeyToPool,
  removeKeyFromPool,
  toggleKeyInPool,
  updateKeyPoolQuota
};
