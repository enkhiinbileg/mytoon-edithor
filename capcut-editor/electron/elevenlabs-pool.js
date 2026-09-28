'use strict';
const path = require('node:path');
const fs = require('node:fs');
const settings = require('./settings');
const tts = require('./tts');
const ff = require('./ffmpeg');
const { classifyError } = require('./elevenlabs-errors');
const { createPartCache } = require('./tts-part-cache');

const API = 'https://api.elevenlabs.io/v1';

/** Fetch quota for a single key directly from ElevenLabs */
async function fetchKeyQuota(apiKey) {
  try {
    const res = await fetch(`${API}/user`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) {
      if (res.status === 401) return { valid: false, error: 'Түлхүүр буруу эсвэл хүчингүй (401).' };
      return { valid: false, error: `ElevenLabs алдаа (${res.status})` };
    }
    const d = await res.json();
    const sub = d.subscription || {};
    const used = sub.character_count ?? 0;
    const limit = sub.character_limit ?? 0;
    const remaining = Math.max(0, limit - used);
    return {
      valid: true,
      userId: d.user_id || '',
      tier: sub.tier ?? 'free',
      used,
      limit,
      remaining
    };
  } catch (err) {
    return { valid: false, error: err.message || 'Сүлжээний алдаа.' };
  }
}

/** Verify a new key and return its quota info */
async function verifyAndAddKey(apiKey, label) {
  const clean = String(apiKey || '').trim();
  if (!clean) throw new Error('API түлхүүр оруулна уу.');

  const quota = await fetchKeyQuota(clean);
  if (!quota.valid) {
    throw new Error(quota.error || 'ElevenLabs түлхүүрийг шалгаж чадсангүй.');
  }

  const quotaInfo = {
    userId: quota.userId || '',
    tier: quota.tier,
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining
  };

  return settings.addKeyToPool(clean, label, quotaInfo);
}

/** Refresh quotas for all registered keys in the pool */
async function refreshAllQuotas() {
  const decrypted = settings.getKeyPoolDecrypted();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, decrypted.length) }, async () => {
   while (cursor < decrypted.length) {
    const it = decrypted[cursor++];
    try {
      const q = await fetchKeyQuota(it.apiKey);
      if (q.valid) {
        settings.updateKeyPoolQuota(it.id, {
          userId: q.userId || '',
          tier: q.tier,
          used: q.used,
          limit: q.limit,
          remaining: q.remaining
        }, it.status === 'blocked' ? 'blocked' : q.remaining <= 0 ? 'exhausted' :
          ['insufficient', 'error'].includes(it.status) ? it.status : 'ready');
      } else {
        settings.updateKeyPoolQuota(it.id, null, it.status === 'blocked' ? 'blocked' : 'error');
      }
    } catch {}
   }
  }));
  return settings.getKeyPoolPublic();
}

/**
 * Pipelined Multi-Key Dispatcher:
 * Concurrently processes text chunks across an active pool of ElevenLabs API keys.
 * If a key hits 429 (Rate Limit) or 402/401 (Quota Exceeded), it immediately failovers
 * to the next available key without failing the entire synthesis.
 */
async function dispatchPoolTTS({
  chunks,
  voiceId = 'TX3LPaxmHKxFdv7VOQHJ',
  modelId = 'eleven_v3',
  stability = 0.5,
  similarity = 0.75,
  speed = 1.0,
  outDir,
  resume = false,
  onProgress
}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('Уншуулах текст олдсонгүй.');
  }

  // 1. Resolve available keys
  let pool = settings.getKeyPoolDecrypted();
  if (!pool || pool.length === 0) {
    const single = settings.secret('elevenLabsApiKey') || process.env.ELEVENLABS_API_KEY;
    if (single) {
      pool = [{
        id: 'fallback_single',
        label: 'Үндсэн түлхүүр',
        apiKey: single,
        enabled: true,
        quota: null,
        status: 'ready'
      }];
    }
  }

  if (!pool || pool.length === 0) {
    throw new Error('ElevenLabs API түлхүүр бүртгэгдээгүй байна. "Түлхүүрийн сан" дээр дарж түлхүүр нэмнэ үү.');
  }

  // State tracker for workers
  const workers = pool.map((k, idx) => ({
    id: k.id,
    label: k.label || `Түлхүүр #${idx + 1}`,
    apiKey: k.apiKey,
    busy: false,
    exhausted: false,
    cooldownUntil: 0,
    jobsCompleted: 0
  }));

  // Queue of chunks to process
  let queue = chunks.map((text, index) => ({
    index,
    text,
    retries: 0,
    failedKeys: new Set()
  }));

  const totalChunks = chunks.length;
  const results = new Array(totalChunks);
  let completedCount = 0;
  let lastQuotaError = '';
  let fatalError = null;
  const controller = new AbortController();
  const cache = resume ? createPartCache(outDir, { voiceId, modelId, stability, similarity, speed }) : null;
  if (cache) {
    for (const task of queue) {
      const hit = await cache.read(task.text);
      if (hit) { results[task.index] = { ...hit, pIdx: task.index }; completedCount++; }
    }
    queue = queue.filter(task => !results[task.index]);
  }

  // Maximum concurrent tasks: min(workers.length, 6)
  const maxConcurrency = Math.min(Math.max(1, workers.length), 6);

  onProgress?.({
    stage: 'pool-start',
    totalChunks,
    completedCount,
    totalKeys: workers.length,
    message: `🎙️ ${completedCount}/${totalChunks} хэсэг хадгалсан аудиогоос бэлэн. Үлдсэн ${queue.length} хэсгийг уншуулна...`
  });

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Helper to find next available worker for a specific task
  function getAvailableWorker(task) {
    const now = Date.now();
    for (const w of workers) {
      if (w.busy) continue;
      if (w.exhausted) continue;
      if (w.cooldownUntil > now) continue;
      if (task.failedKeys.has(w.id)) continue;
      return w;
    }
    // If all eligible workers failed on this task, allow re-trying non-busy ones
    for (const w of workers) {
      if (!w.busy && !w.exhausted && w.cooldownUntil <= now) {
        return w;
      }
    }
    return null;
  }

  // Worker loop
  async function runWorker() {
    while (queue.length > 0 && !fatalError) {
      const task = queue.shift();
      if (!task) break;

      let worker = getAvailableWorker(task);

      // If all workers are busy or in cooldown, wait and retry
      while (!worker) {
        if (fatalError) return;
        const anyUsable = workers.some((w) => !w.exhausted);
        if (!anyUsable) {
          throw new Error(`Хэсэг ${task.index + 1} (${task.text.length} тэмдэгт)-ийг уншуулахад түлхүүр тус бүрийн кредит хүрсэнгүй. Нийлбэр үлдэгдлээр нэг хүсэлтийг төлөх боломжгүй.\n${lastQuotaError}`);
        }
        await sleep(500);
        worker = getAvailableWorker(task);
      }

      worker.busy = true;

      onProgress?.({
        stage: 'pool-chunk-start',
        chunkIndex: task.index,
        totalChunks,
        completedCount,
        keyLabel: worker.label,
        message: `🎙️ [Хэсэг ${task.index + 1}/${totalChunks}] -> ${worker.label} уншиж байна...`
      });

      const partAudioFile = path.join(
        outDir,
        `pool_part_${task.index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`
      );

      try {
        const ttsRes = await tts.speakWithTimestamps('elevenlabs', {
          apiKey: worker.apiKey,
          voiceId,
          text: task.text,
          modelId,
          stability,
          similarity,
          speed,
          file: partAudioFile,
          signal: controller.signal
        });

        if (!fs.existsSync(partAudioFile)) {
          throw new Error('Аудио файл үүссэнгүй.');
        }

        const probeRes = await ff.probe(partAudioFile);
        const partDuration = probeRes.duration || ttsRes.duration || 5;
        const partSentences = ttsRes.sentences || [];

        // Fallback sentence slicing if alignment missing
        if (!partSentences.length) {
          const lines = task.text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
          const step = partDuration / Math.max(1, lines.length);
          for (let i = 0; i < lines.length; i++) {
            partSentences.push({
              id: i,
              text: lines[i].trim(),
              start: Math.round(i * step * 100) / 100,
              end: Math.round(Math.min(partDuration, (i + 1) * step) * 100) / 100
            });
          }
        }

        results[task.index] = {
          pIdx: task.index,
          partAudioFile,
          partDuration,
          partSentences,
          keyUsed: worker.label
        };

        // Persist each success before continuing: a later API failure must not charge it again.
        if (cache) {
          try { await cache.write(task.text, results[task.index]); }
          catch (error) {
            // Never retry paid synthesis because a local cache write failed.
            throw Object.assign(new Error(`Аудио үүссэн боловч үргэлжлүүлэх мэдээлэл хадгалж чадсангүй: ${error.message}`), { status: 400 });
          }
        }

        completedCount++;
        worker.jobsCompleted++;
        worker.busy = false;
        settings.updateKeyPoolQuota(worker.id, null, 'ready');

        onProgress?.({
          stage: 'pool-chunk-done',
          chunkIndex: task.index,
          completedCount,
          totalChunks,
          keyLabel: worker.label,
          message: `✅ [${completedCount}/${totalChunks}] хэсэг амжилттай (${worker.label})...`
        });
      } catch (err) {
        worker.busy = false;
        if (fatalError) return;
        const errMsg = String(err.message || err);
        const kind = classifyError(err);
        task.retries++;
        if (kind === 'terminal') {
          settings.updateKeyPoolQuota(worker.id, null, err.code === 'detected_unusual_activity' ? 'blocked' : 'error');
          throw new Error(`${worker.label}: ${errMsg}\nКредит дууссан гэж тэмдэглээгүй. API-ийн дээрх шалтгааныг шийдээд дахин оролдоно уу.`);
        }

        if (kind === 'rate') {
          worker.cooldownUntil = Date.now() + Math.max(25000, Math.min(err.retryAfterMs || 0, 120000));
          onProgress?.({
            stage: 'pool-chunk-failover',
            chunkIndex: task.index,
            keyLabel: worker.label,
            message: `⚠️ ${worker.label} хурдны хязгаар (429) авсан тул түр амрааж, өөр түлхүүр рүү шилжүүлж байна...`
          });
        } else if (kind === 'quota') {
          lastQuotaError = `${worker.label}: ${errMsg}`;
          worker.exhausted = true;
          settings.updateKeyPoolQuota(worker.id, null, 'insufficient');
          onProgress?.({
            stage: 'pool-chunk-failover',
            chunkIndex: task.index,
            keyLabel: worker.label,
            message: `⚠️ ${worker.label}: энэ хэсэгт кредит хүрэлцэхгүй (quota_exceeded). Дараагийн түлхүүрийг шалгаж байна...`
          });
        } else {
          task.failedKeys.add(worker.id);
          onProgress?.({
            stage: 'pool-chunk-retry',
            chunkIndex: task.index,
            keyLabel: worker.label,
            message: `⚠️ Хэсэг ${task.index + 1} алдаа: ${errMsg.slice(0, 80)}. Өөр түлхүүрээр дахин оролдож байна...`
          });
        }

        // Re-queue task to top
        task.failedKeys.add(worker.id);
        if (task.retries < Math.max(4, workers.length * 2)) {
          queue.unshift(task);
        } else {
          throw new Error(`Хэсэг ${task.index + 1}-ийг олон удаа оролдсон боловч уншиж чадсангүй: ${errMsg}`);
        }

        await sleep(600);
      }
    }
  }

  // Launch worker threads concurrently
  const runnerPromises = [];
  for (let i = 0; i < maxConcurrency; i++) {
    runnerPromises.push(runWorker().catch(error => {
      if (!fatalError) { fatalError = error; controller.abort(); }
    }));
  }

  await Promise.all(runnerPromises);
  if (fatalError) {
    if (cache) fatalError.message += `\n${completedCount}/${totalChunks} хэсэг хадгалагдсан. Ижил текст, хоолой, тохиргоогоор дахин эхлүүлэхэд бэлэн хэсгүүдийг дахин уншуулахгүй.`;
    throw fatalError;
  }

  // Verify all parts exist
  for (let i = 0; i < totalChunks; i++) {
    if (!results[i]) {
      throw new Error(`Хэсэг ${i + 1} дутуу байна.`);
    }
  }

  return results;
}

module.exports = {
  fetchKeyQuota,
  verifyAndAddKey,
  refreshAllQuotas,
  dispatchPoolTTS
};
