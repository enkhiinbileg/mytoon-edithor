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
        const nextStatus = it.status === 'blocked'
          ? 'blocked'
          : (typeof q.remaining === 'number' && q.remaining <= 0)
          ? 'exhausted'
          : 'ready';
        settings.updateKeyPoolQuota(it.id, {
          userId: q.userId || '',
          tier: q.tier,
          used: q.used,
          limit: q.limit,
          remaining: q.remaining
        }, nextStatus);
      } else {
        settings.updateKeyPoolQuota(it.id, null, it.status === 'blocked' ? 'blocked' : 'error');
      }
    } catch {}
   }
  }));
  return settings.getKeyPoolPublic();
}

/**
 * Splits text into two parts at the nearest natural boundary (sentence, clause, word)
 * such that part1 is <= maxChars.
 */
function splitTaskAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return null;
  const sub = text.slice(0, maxChars);
  const minCut = Math.max(15, Math.floor(maxChars * 0.15));

  // 1. Sentence endings: . ! ? followed by whitespace
  const sentenceMatches = [...sub.matchAll(/(?<=[.!?\n])\s+/g)];
  if (sentenceMatches.length > 0) {
    const last = sentenceMatches[sentenceMatches.length - 1];
    const cutPos = last.index + last[0].length;
    if (cutPos >= minCut) {
      const p1 = text.slice(0, cutPos).trim();
      const p2 = text.slice(cutPos).trim();
      if (p1 && p2) return [p1, p2];
    }
  }

  // 2. Clause endings: , ; : followed by whitespace
  const clauseMatches = [...sub.matchAll(/(?<=[,;:\n])\s+/g)];
  if (clauseMatches.length > 0) {
    const last = clauseMatches[clauseMatches.length - 1];
    const cutPos = last.index + last[0].length;
    if (cutPos >= minCut) {
      const p1 = text.slice(0, cutPos).trim();
      const p2 = text.slice(cutPos).trim();
      if (p1 && p2) return [p1, p2];
    }
  }

  // 3. Word boundary: whitespace
  const lastSpace = sub.lastIndexOf(' ');
  if (lastSpace >= minCut) {
    const p1 = text.slice(0, lastSpace).trim();
    const p2 = text.slice(lastSpace).trim();
    if (p1 && p2) return [p1, p2];
  }

  // 4. Fallback cut at maxChars if no punctuation or space matches inside minCut
  if (maxChars >= 15) {
    const p1 = text.slice(0, maxChars).trim();
    const p2 = text.slice(maxChars).trim();
    if (p1 && p2) return [p1, p2];
  }

  return null;
}

/** Lexicographical comparison for hierarchical paths */
function comparePaths(a, b) {
  const pA = a.path || [0];
  const pB = b.path || [0];
  const len = Math.min(pA.length, pB.length);
  for (let i = 0; i < len; i++) {
    if (pA[i] !== pB[i]) return pA[i] - pB[i];
  }
  return pA.length - pB.length;
}

/**
 * Pipelined Multi-Key Dispatcher:
 * Concurrently processes text chunks across an active pool of ElevenLabs API keys.
 * Quota-aware: allocates tasks based on remaining credits, dynamically sub-chunks
 * tasks when remaining credits are fragmented, and safely failovers on rate-limits.
 */
async function dispatchPoolTTS({
  chunks,
  voiceId = 'TX3LPaxmHKxFdv7VOQHJ',
  modelId = 'eleven_v4',
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

  // Filter out blocked keys
  pool = (pool || []).filter((k) => k.enabled !== false && k.status !== 'blocked');

  if (pool.length === 0) {
    throw new Error('Идэвхтэй ElevenLabs API түлхүүр олдсонгүй. "Түлхүүрийн сан" дээр дарж түлхүүр нэмнэ үү.');
  }

  // State tracker for workers with real-time remaining credit balances
  const workers = pool.map((k, idx) => {
    const rem = (k.quota && typeof k.quota.remaining === 'number') ? k.quota.remaining : 10000;
    return {
      id: k.id,
      label: k.label || `Түлхүүр #${idx + 1}`,
      apiKey: k.apiKey,
      busy: false,
      exhausted: rem <= 0,
      cooldownUntil: 0,
      jobsCompleted: 0,
      remaining: rem,
      quota: k.quota ? { ...k.quota } : null
    };
  });

  // Queue of chunks to process using hierarchical path tracking for strict sequencing
  let queue = chunks
    .map((text, index) => ({
      path: [index],
      text: (text || '').trim(),
      retries: 0,
      failedKeys: new Set()
    }))
    .filter((task) => Boolean(task.text));

  const initialTotal = queue.length;
  const completedResults = [];
  let completedCount = 0;
  let lastQuotaError = '';
  let fatalError = null;
  const controller = new AbortController();
  const cache = resume ? createPartCache(outDir, { voiceId, modelId, stability, similarity, speed }) : null;

  if (cache) {
    const remainingTasks = [];
    for (const task of queue) {
      const hit = await cache.read(task.text);
      if (hit) {
        completedResults.push({ ...hit, path: task.path });
        completedCount++;
      } else {
        remainingTasks.push(task);
      }
    }
    queue = remainingTasks;
  }

  // Maximum concurrent tasks: min(workers.length, 6)
  const maxConcurrency = Math.min(Math.max(1, workers.length), 6);

  onProgress?.({
    stage: 'pool-start',
    totalChunks: initialTotal,
    completedCount,
    totalKeys: workers.length,
    message: `🎙️ ${completedCount}/${initialTotal} хэсэг бэлэн. Үлдсэн ${queue.length} хэсгийг ${workers.length} түлхүүрээр уншуулна...`
  });

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  function getModelCreditMultiplier(mId) {
    const m = String(mId || '').toLowerCase();
    if (m.includes('turbo') || m.includes('flash')) return 0.5;
    return 1.0;
  }
  const modelMultiplier = getModelCreditMultiplier(modelId);

  function getMaxRequestLimit(w) {
    const tier = String(w.quota?.tier || '').toLowerCase();
    if (tier === 'free') return 2450;
    if (tier === 'starter') return 5000;
    return 10000;
  }

  // Helper to find next available worker with sufficient remaining credits and tier capacity
  function getAvailableWorker(task) {
    const now = Date.now();
    const reqChars = task.text.length;
    const reqCredits = Math.ceil(reqChars * modelMultiplier);

    const eligible = workers.filter(
      (w) => !w.busy && !w.exhausted && w.cooldownUntil <= now && !task.failedKeys.has(w.id)
    );

    // Prefer workers with enough credits for this chunk AND within tier per-request character limit
    const sufficient = eligible.filter((w) => {
      const charLimit = getMaxRequestLimit(w);
      return charLimit >= reqChars && w.remaining >= reqCredits;
    });

    if (sufficient.length > 0) {
      // Best-fit: pick worker with smallest sufficient balance first
      // to maximize pool utilization and preserve high-balance keys
      sufficient.sort((a, b) => a.remaining - b.remaining);
      return sufficient[0];
    }

    return null;
  }

  // Worker loop
  async function runWorker() {
    while (!fatalError) {
      if (queue.length === 0) {
        // If queue is empty, wait briefly if any worker is still actively synthesizing,
        // in case an active worker fails and re-queues, or a sub-chunk is split
        const anyBusy = workers.some((w) => w.busy);
        if (!anyBusy) break;
        await sleep(250);
        continue;
      }

      const task = queue.shift();
      if (!task) continue;

      let worker = getAvailableWorker(task);

      // If worker not immediately available, handle busy / fragmented credits / tier limits
      while (!worker && !fatalError) {
        const now = Date.now();
        const usableWorkers = workers.filter((w) => !w.exhausted && w.remaining > 0);

        if (usableWorkers.length === 0) {
          throw new Error(
            `Бүх түлхүүрийн кредит дууссан байна. Үлдсэн хэсгийг (${task.text.length} тэмдэгт) уншуулах боломжгүй.\n${lastQuotaError}`
          );
        }

        const idleWorkers = usableWorkers.filter(
          (w) => !w.busy && w.cooldownUntil <= now && !task.failedKeys.has(w.id)
        );

        if (idleWorkers.length > 0) {
          const maxIdleAllowed = Math.max(...idleWorkers.map((w) => {
            const charLimit = getMaxRequestLimit(w);
            const affordableChars = Math.floor(w.remaining / modelMultiplier);
            return Math.min(charLimit, affordableChars);
          }));
          // If task text is larger than any idle worker's allowed limit, dynamically sub-chunk it!
          if (task.text.length > maxIdleAllowed && maxIdleAllowed >= 20) {
            const splitPair = splitTaskAtBoundary(task.text, Math.max(15, maxIdleAllowed - 5));
            if (splitPair) {
              const [part1, part2] = splitPair;
              const subTask1 = {
                path: [...task.path, 0],
                text: part1,
                retries: 0,
                failedKeys: new Set(task.failedKeys)
              };
              const subTask2 = {
                path: [...task.path, 1],
                text: part2,
                retries: 0,
                failedKeys: new Set()
              };
              queue.unshift(subTask2);
              queue.unshift(subTask1);
              break; // Outer loop will shift subTask1
            }
          }
        }

        // If any usable workers are busy or cooling down, wait for them to finish
        const anyBusyOrCooldown = usableWorkers.some((w) => w.busy || w.cooldownUntil > now);
        if (anyBusyOrCooldown) {
          queue.unshift(task);
          await sleep(400);
          break;
        }

        // If task failed on all available idle workers, clear failedKeys to permit retrying
        if (task.failedKeys.size > 0 && idleWorkers.length === 0) {
          task.failedKeys.clear();
          worker = getAvailableWorker(task);
          if (worker) break;
        }

        // If no workers are busy and task cannot be split into any worker's balance or tier limit
        const maxOverall = Math.max(...usableWorkers.map((w) => {
          const charLimit = getMaxRequestLimit(w);
          const affordableChars = Math.floor(w.remaining / modelMultiplier);
          return Math.min(charLimit, affordableChars);
        }));
        if (task.text.length > maxOverall) {
          if (maxOverall >= 20) {
            const splitPair = splitTaskAtBoundary(task.text, Math.max(15, maxOverall - 5));
            if (splitPair) {
              const [part1, part2] = splitPair;
              const subTask1 = {
                path: [...task.path, 0],
                text: part1,
                retries: 0,
                failedKeys: new Set(task.failedKeys)
              };
              const subTask2 = {
                path: [...task.path, 1],
                text: part2,
                retries: 0,
                failedKeys: new Set()
              };
              queue.unshift(subTask2);
              queue.unshift(subTask1);
              break;
            }
          }
          const neededCredits = Math.ceil(task.text.length * modelMultiplier);
          const maxCredits = Math.max(...usableWorkers.map((w) => w.remaining));
          throw new Error(
            `Хэсэг (${task.text.length} тэмдэгт, ~${neededCredits} кредит)-ийг уншуулахад түлхүүрүүдийн үлдэгдэл хүрэлцэхгүй байна (Хамгийн их үлдэгдэл: ${maxCredits} кредит).`
          );
        }

        await sleep(500);
        worker = getAvailableWorker(task);
      }

      if (!worker) continue;

      worker.busy = true;
      const displayTotal = Math.max(initialTotal, completedCount + queue.length + 1);

      onProgress?.({
        stage: 'pool-chunk-start',
        chunkIndex: completedCount + 1,
        totalChunks: displayTotal,
        completedCount,
        keyLabel: worker.label,
        message: `🎙️ [${completedCount + 1}/${displayTotal}] -> ${worker.label} уншиж байна (${task.text.length} тэмдэгт)...`
      });

      const partAudioFile = path.join(
        outDir,
        `pool_part_${task.path.join('_')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`
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

        const completedItem = {
          path: task.path,
          partAudioFile,
          partDuration,
          partSentences,
          keyUsed: worker.label
        };
        completedResults.push(completedItem);

        // Persist each success before continuing
        if (cache) {
          try {
            await cache.write(task.text, completedItem);
          } catch (error) {
            throw Object.assign(
              new Error(`Аудио хадгалахад алдаа гарлаа: ${error.message}`),
              { status: 400 }
            );
          }
        }

        // Deduct credits used according to model tariff multiplier
        const creditsDeducted = Math.ceil(task.text.length * modelMultiplier);
        worker.remaining = Math.max(0, worker.remaining - creditsDeducted);
        if (worker.quota) {
          worker.quota.remaining = worker.remaining;
          worker.quota.used = (worker.quota.used || 0) + creditsDeducted;
        }
        if (worker.remaining <= 0) {
          worker.exhausted = true;
        }
        const nextStatus = worker.remaining <= 0 ? 'exhausted' : 'ready';
        settings.updateKeyPoolQuota(worker.id, worker.quota, nextStatus);

        completedCount++;
        worker.jobsCompleted++;
        worker.busy = false;

        onProgress?.({
          stage: 'pool-chunk-done',
          chunkIndex: completedCount,
          completedCount,
          totalChunks: displayTotal,
          keyLabel: worker.label,
          message: `✅ [${completedCount}/${displayTotal}] хэсэг амжилттай (${worker.label}, -${creditsDeducted} кредит, үлдэгдэл: ${worker.remaining.toLocaleString()})...`
        });
      } catch (err) {
        worker.busy = false;
        if (fatalError) return;
        const causeStr = err.cause?.message || err.cause?.code || '';
        const errMsg = causeStr ? `${err.message} (${causeStr})` : String(err.message || err);
        const kind = classifyError(err);
        task.retries++;

        if (kind === 'terminal') {
          settings.updateKeyPoolQuota(worker.id, null, err.code === 'detected_unusual_activity' ? 'blocked' : 'error');
          throw new Error(`${worker.label}: ${errMsg}\nAPI-ийн тохиргоог шалгана уу.`);
        }

        if (kind === 'rate') {
          worker.cooldownUntil = Date.now() + Math.max(25000, Math.min(err.retryAfterMs || 0, 120000));
          task.failedKeys.add(worker.id);
          onProgress?.({
            stage: 'pool-chunk-failover',
            keyLabel: worker.label,
            message: `⚠️ ${worker.label} хурдны хязгаар (429) авсан тул түр амрааж, өөр түлхүүр рүү шилжүүлж байна...`
          });
        } else if (kind === 'quota') {
          lastQuotaError = `${worker.label}: ${errMsg}`;
          worker.exhausted = true;
          worker.remaining = 0;
          if (worker.quota) worker.quota.remaining = 0;
          settings.updateKeyPoolQuota(worker.id, worker.quota, 'exhausted');
          task.failedKeys.add(worker.id);
          onProgress?.({
            stage: 'pool-chunk-failover',
            keyLabel: worker.label,
            message: `⚠️ ${worker.label} кредит дууссан (quota_exceeded). Дараагийн түлхүүр рүү шилжүүлж байна...`
          });
        } else {
          task.failedKeys.add(worker.id);
          onProgress?.({
            stage: 'pool-chunk-retry',
            keyLabel: worker.label,
            message: `⚠️ ${worker.label} алдаа: ${errMsg.slice(0, 80)}. Өөр түлхүүрээр дахин оролдож байна...`
          });
        }

        // Re-queue task to top
        if (task.retries < Math.max(6, workers.length * 3)) {
          queue.unshift(task);
        } else {
          throw new Error(`Хэсгийг олон удаа оролдсон боловч уншиж чадсангүй: ${errMsg}`);
        }

        await sleep(500);
      }
    }
  }

  // Launch worker threads concurrently
  const runnerPromises = [];
  for (let i = 0; i < maxConcurrency; i++) {
    runnerPromises.push(
      runWorker().catch((error) => {
        if (!fatalError) {
          fatalError = error;
          controller.abort();
        }
      })
    );
  }

  await Promise.all(runnerPromises);
  if (fatalError) {
    if (cache) {
      fatalError.message += `\n${completedCount}/${initialTotal} хэсэг хадгалагдсан. Дахин эхлүүлэхэд бэлэн хэсгүүдийг дахин уншуулахгүй.`;
    }
    throw fatalError;
  }

  // Sort completed parts strictly by hierarchical path
  completedResults.sort(comparePaths);
  const finalResults = completedResults.map((r, i) => ({
    ...r,
    pIdx: i
  }));

  return finalResults;
}

module.exports = {
  fetchKeyQuota,
  verifyAndAddKey,
  refreshAllQuotas,
  dispatchPoolTTS
};
