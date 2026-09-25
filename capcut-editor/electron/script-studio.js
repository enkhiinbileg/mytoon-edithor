'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tts = require('./tts');
const ff = require('./ffmpeg');
const visionSync = require('./vision-sync');
const settings = require('./settings');
const pool = require('./elevenlabs-pool');

/**
 * Intelligently splits a long script into chunks of <= maxChars (e.g. 2800 characters)
 * keeping complete sentences, clauses and natural pauses.
 */
function splitScriptIntoChunks(text, maxChars = 2500) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const rawSentences = trimmed
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = '';

  for (const sentence of rawSentences) {
    if (sentence.length > maxChars) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      const clauses = sentence.split(/(?<=[,;:\n])\s+/).filter(Boolean);
      for (const clause of clauses) {
        if (clause.length > maxChars) {
          const words = clause.split(/\s+/);
          for (const word of words) {
            if ((currentChunk + ' ' + word).length > maxChars) {
              if (currentChunk.trim()) chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              currentChunk = currentChunk ? currentChunk + ' ' + word : word;
            }
          }
        } else if ((currentChunk + ' ' + clause).length > maxChars) {
          if (currentChunk.trim()) chunks.push(currentChunk.trim());
          currentChunk = clause;
        } else {
          currentChunk = currentChunk ? currentChunk + ' ' + clause : clause;
        }
      }
      continue;
    }

    if ((currentChunk + ' ' + sentence).length > maxChars) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    } else {
      currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * AI Script Studio:
 * 1. Takes raw Mongolian script text from the user.
 * 2. Splits script into <=2800 character chunks for ElevenLabs.
 * 3. Generates studio-grade voiceover via ElevenLabs with exact sentence timestamps.
 * 4. Concatenates audio parts and computes cumulative sentence timings.
 * 5. Rule 1: Video is already in chronological order. Sequentially matches sentences
 *    by stretching (freeze & stretch) or cutting the video in exact story order.
 */
async function buildScriptRecap(spec, progress) {
  const {
    scriptText,
    voiceId = 'TX3LPaxmHKxFdv7VOQHJ',
    modelId = 'eleven_v3',
    stability = 0.5,
    similarity = 0.75,
    speed = 1.0,
    videoPath,
    sourceOffset = 0,
    geminiModel = 'gemini-2.5-flash',
    mode = 'hybrid', // 'hybrid' (Хөдөлгөөнтэй үед Cut + дуу үргэлжлэхэд Freeze) | 'freeze' | 'cut' | 'audio_only'
    audioOnly = false,
    useVision = false, // Rule 1: false by default
    panelPacing = 'auto'
  } = spec;

  const isAudioOnly = Boolean(audioOnly || mode === 'audio_only' || !videoPath);

  if (!scriptText || !scriptText.trim()) {
    throw new Error('Монгол скрипт текст оруулаагүй байна.');
  }
  const cleanScript = scriptText.trim();

  // Multi-key pool capacity calculation
  const poolKeys = settings.getKeyPoolDecrypted();
  const totalCapacity = poolKeys.reduce((acc, k) => acc + (k.quota?.remaining ?? 10000), 0);
  if (poolKeys.length === 0 && !spec.elevenLabsApiKey && !settings.secret('elevenLabsApiKey') && !process.env.ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API түлхүүр бүртгэгдээгүй байна. "Түлхүүрийн сан" (API Key Pool) дээр дарж түлхүүрээ оруулна уу.');
  }

  if (cleanScript.length > Math.max(120000, totalCapacity * 1.5)) {
    throw new Error(`Скрипт хэтэрхий урт байна (${cleanScript.length.toLocaleString()} тэмдэгт). Түлхүүрийн нийт багтаамжаар хувааж оруулна уу.`);
  }

  let video = null;
  if (!isAudioOnly) {
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('Сонгосон эх видео файл олдсонгүй.');
    }

    const geminiApiKey =
      spec.geminiApiKey ||
      settings.secret('geminiApiKey') ||
      process.env.GEMINI_API_KEY ||
      '';

    video = await ff.probe(videoPath);
    if (!video.hasVideo || video.duration <= 0) {
      throw new Error('Эх видео дүрсний мэдээлэлгүй байна.');
    }
  }

  // 1. Synthesize audio via ElevenLabs Multi-Key Dispatcher in safe chunks (<= 2200 chars per API call)
  const scriptChunks = splitScriptIntoChunks(cleanScript, 2200);
  const audioDir = path.join(app.getPath('userData'), 'script-studio-audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioFile = path.join(audioDir, `voice_master_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`);

  const partFiles = [];
  const rawSentences = [];
  let cumulativeTimeOffset = 0;

  const targetVoiceId = voiceId || 'TX3LPaxmHKxFdv7VOQHJ';

  // Process all chunks concurrently across active API keys in the pool
  const partResults = await pool.dispatchPoolTTS({
    chunks: scriptChunks,
    voiceId: targetVoiceId,
    modelId,
    stability,
    similarity,
    speed,
    outDir: audioDir,
    onProgress: (p) => {
      progress?.({
        stage: 'tts',
        partIndex: p.completedCount || (p.chunkIndex !== undefined ? p.chunkIndex + 1 : 0),
        totalParts: p.totalChunks || scriptChunks.length,
        keyLabel: p.keyLabel,
        message: p.message
      });
    }
  });

  // Maintain strict sequential order of parts
  partResults.sort((a, b) => a.pIdx - b.pIdx);

  for (const item of partResults) {
    partFiles.push(item.partAudioFile);
    for (const s of item.partSentences) {
      rawSentences.push({
        id: rawSentences.length,
        text: s.text,
        start: Math.round((s.start + cumulativeTimeOffset) * 100) / 100,
        end: Math.round((s.end + cumulativeTimeOffset) * 100) / 100
      });
    }
    cumulativeTimeOffset += item.partDuration;
  }

  // Concatenate parts into single master audio
  if (scriptChunks.length > 1) {
    progress?.({ stage: 'tts', message: `🎙️ ElevenLabs: Нийт ${scriptChunks.length} хэсгийн дууг нэгтгэж байна...` });
  }
  await ff.concatAudioFiles(partFiles, audioFile);

  const audioProbe = await ff.probe(audioFile);
  const voiceDuration = audioProbe.duration || cumulativeTimeOffset;

  // 1.5. If Audio-Only mode was requested, return early with master audio and sentence timings!
  if (isAudioOnly) {
    progress?.({
      stage: 'done',
      message: `✨ Дуу хоолой амжилттай үүслээ! (${Math.round(voiceDuration)} сек, ${scriptChunks.length} хэсэг)`
    });
    return {
      ok: true,
      audioPath: audioFile,
      voiceDuration,
      sentences: rawSentences,
      cuts: [],
      mode: 'audio_only',
      chunksCount: scriptChunks.length
    };
  }

  // 2. Rule 1: Video is already in exact chronological order!
  // Fast scene cut detection to find comic panel boundaries sequentially
  progress?.({ stage: 'chunk-start', message: '🎬 Rule 1: Эх бичлэгийн дараалсан үзэгдлүүдийг тооцоолж байна...' });
  let detectedCuts = [];
  try {
    const scanDur = Math.min(25, Math.max(10, rawSentences.length * 1.5));
    detectedCuts = await ff.detectSceneCuts(videoPath, 0.22, { startOffset: sourceOffset, duration: scanDur });
  } catch (err) {
    console.warn('[ScriptStudio] Scene cut detection skipped:', err.message);
  }

  // Determine sequential step per panel/sentence
  let defaultStep = 2.5;
  if (typeof panelPacing === 'number' && panelPacing > 0) {
    defaultStep = panelPacing;
  } else if (rawSentences.length > 0 && video.duration > sourceOffset) {
    const availVideo = video.duration - sourceOffset;
    defaultStep = Math.max(1.5, Math.min(4.5, (availVideo - 1) / rawSentences.length));
  }

  // Group sentences into progressive chunks (5 sentences per chunk)
  const CHUNK_SIZE = 5;
  const chunkGroups = [];
  for (let i = 0; i < rawSentences.length; i += CHUNK_SIZE) {
    chunkGroups.push(rawSentences.slice(i, i + CHUNK_SIZE));
  }

  let curSource = Number.isFinite(sourceOffset) ? Math.max(0, Math.min(video.duration - 0.5, sourceOffset)) : 0;
  const allCuts = [];
  const totalChunks = chunkGroups.length;
  let visionAIUsed = false;
  let visionError = null;

  for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
    const chunkSegs = chunkGroups[cIdx];
    const chunkStart = chunkSegs[0].start;
    const chunkEnd = chunkSegs[chunkSegs.length - 1].end;
    const chunkDuration = Math.max(4, chunkEnd - chunkStart);

    progress?.({
      stage: 'chunk-start',
      chunkIndex: cIdx,
      totalChunks,
      message: `⚡ [${cIdx + 1}/${totalChunks}] ${chunkSegs.length} өгүүлбэрт дарааллаар нь дүрс оноож байна...`
    });

    let chunkMatches = null;
    let chunkKeyframes = [];

    // Only use Vision AI if user explicitly requested it
    if (useVision && geminiApiKey) {
      try {
        const searchDur = Math.min(video.duration - curSource, Math.max(15, chunkDuration * 1.5));
        const targetFrames = Math.min(10, Math.max(5, chunkSegs.length * 2));
        chunkKeyframes = await visionSync.extractKeyframes(videoPath, {
          startOffset: curSource,
          searchDuration: searchDur,
          targetFrames
        });

        if (chunkKeyframes.length) {
          const matches = await visionSync.matchWithGeminiVision({
            speechSegments: chunkSegs,
            keyframes: chunkKeyframes,
            apiKey: geminiApiKey,
            model: geminiModel
          });
          if (matches && matches.length) {
            chunkMatches = matches;
            visionAIUsed = true;
          }
        }
      } catch (vErr) {
        visionError = vErr.message;
        console.warn(`[ScriptStudio] Chunk ${cIdx} vision fallback:`, vErr.message);
      }
    }

    // Determine target cuts for this chunk according to Rule 1
    const chunkCutSpecs = [];
    for (let j = 0; j < chunkSegs.length; j++) {
      const seg = chunkSegs[j];
      const globalIdx = allCuts.length + j;
      const tStart = (globalIdx === 0) ? 0 : seg.start;
      const nextSeg = (j < chunkSegs.length - 1) ? chunkSegs[j + 1] : (cIdx < totalChunks - 1 ? chunkGroups[cIdx + 1][0] : null);
      const tEnd = nextSeg ? nextSeg.start : voiceDuration;
      const cutDur = Math.max(0.4, tEnd - tStart);

      // Rule 1: strictly sequential timestamp
      let matchedTs = curSource;
      let nextSceneBound = null;

      if (detectedCuts.length > globalIdx && detectedCuts[globalIdx] >= curSource) {
        matchedTs = detectedCuts[globalIdx];
        const nextDetected = detectedCuts.find((c) => c > matchedTs + 0.6);
        nextSceneBound = nextDetected || (matchedTs + defaultStep);
      } else if (chunkMatches && chunkMatches.length) {
        const vMatch = chunkMatches.find((m) => m.blockId === seg.id || m.blockId === j);
        if (vMatch && Number.isFinite(vMatch.sourceTimestamp) && vMatch.sourceTimestamp >= curSource - 0.5) {
          matchedTs = Math.max(curSource, Math.min(curSource + 4.5, vMatch.sourceTimestamp));
        } else {
          matchedTs = curSource;
        }
        nextSceneBound = matchedTs + defaultStep;
      } else {
        matchedTs = Math.min(video.duration - 0.2, curSource);
        nextSceneBound = matchedTs + defaultStep;
      }

      if (mode === 'hybrid') {
        // Dynamic Hybrid Pro Director:
        // Play action motion cut, and if speech extends significantly, freeze & hold the settled panel frame!
        const maxMotion = Math.max(1.8, Math.min(3.8, (nextSceneBound || (matchedTs + defaultStep)) - matchedTs));

        if (cutDur > maxMotion + 0.8) {
          const motionDur = Math.max(1.2, Math.min(cutDur - 0.5, maxMotion));
          const freezeDur = cutDur - motionDur;
          const freezeTs = Math.min(video.duration - 0.1, matchedTs + motionDur);

          // Part A: Action motion cut
          chunkCutSpecs.push({
            id: globalIdx * 10,
            matchedTs,
            tStart,
            tEnd: tStart + motionDur,
            cutDur: motionDur,
            shouldFreeze: false,
            text: seg.text || `Өгүүлбэр ${globalIdx + 1}`,
            reason: `🎬 Хөдөлгөөн (${matchedTs.toFixed(1)}s)`
          });

          // Part B: Freeze & hold the settled panel frame for the climax/dialogue
          chunkCutSpecs.push({
            id: globalIdx * 10 + 1,
            matchedTs: freezeTs,
            freezeTs,
            tStart: tStart + motionDur,
            tEnd,
            cutDur: freezeDur,
            shouldFreeze: true,
            text: seg.text || `Өгүүлбэр ${globalIdx + 1} (Царцаалт)`,
            reason: `❄️ Царцаах (${freezeTs.toFixed(1)}s)`
          });

          curSource = Math.min(video.duration - 0.2, freezeTs);
        } else {
          // Visual motion covers the full sentence duration
          chunkCutSpecs.push({
            id: globalIdx * 10,
            matchedTs,
            tStart,
            tEnd,
            cutDur,
            shouldFreeze: false,
            text: seg.text || `Өгүүлбэр ${globalIdx + 1}`,
            reason: `🎬 Хөдөлгөөн Cut (${matchedTs.toFixed(1)}s)`
          });
          curSource = Math.min(video.duration - 0.2, matchedTs + cutDur);
        }
      } else if (mode === 'freeze') {
        // Full freeze & stretch
        chunkCutSpecs.push({
          id: globalIdx,
          matchedTs,
          freezeTs: matchedTs,
          tStart,
          tEnd,
          cutDur,
          shouldFreeze: true,
          text: seg.text || `Өгүүлбэр ${globalIdx + 1}`,
          reason: `❄️ Царцаах (${matchedTs.toFixed(1)}s)`
        });
        curSource = Math.min(video.duration - 0.2, matchedTs + defaultStep);
      } else {
        // Full motion cut
        chunkCutSpecs.push({
          id: globalIdx,
          matchedTs,
          tStart,
          tEnd,
          cutDur,
          shouldFreeze: false,
          text: seg.text || `Өгүүлбэр ${globalIdx + 1}`,
          reason: `🎬 Cut (${matchedTs.toFixed(1)}s)`
        });
        curSource = Math.min(video.duration - 0.2, matchedTs + cutDur);
      }
    }

    // Parallel extract freeze frames for this chunk using in-memory keyframe cache
    const freezeTimestamps = chunkCutSpecs.filter((c) => c.shouldFreeze).map((c) => c.freezeTs ?? c.matchedTs);
    let freezeMap = new Map();
    if (freezeTimestamps.length) {
      try {
        freezeMap = await ff.extractFreezeFrameBatch(videoPath, freezeTimestamps, chunkKeyframes);
      } catch (fErr) {
        console.warn(`[ScriptStudio] Chunk ${cIdx} freeze batch fallback:`, fErr.message);
      }
    }

    const chunkCuts = [];
    for (const specItem of chunkCutSpecs) {
      const fTs = specItem.freezeTs ?? specItem.matchedTs;
      const freezeImagePath = specItem.shouldFreeze ? (freezeMap.get(fTs) || null) : null;
      const cutObj = {
        id: specItem.id,
        sourceStart: Math.round(specItem.matchedTs * 1000) / 1000,
        sourceEnd: Math.round((specItem.matchedTs + (specItem.shouldFreeze ? 0.1 : specItem.cutDur)) * 1000) / 1000,
        targetStart: Math.round(specItem.tStart * 1000) / 1000,
        targetEnd: Math.round(specItem.tEnd * 1000) / 1000,
        duration: Math.round(specItem.cutDur * 1000) / 1000,
        text: specItem.text,
        reason: specItem.reason,
        freeze: specItem.shouldFreeze && Boolean(freezeImagePath),
        freezeImagePath
      };
      chunkCuts.push(cutObj);
      allCuts.push(cutObj);
    }

    // Stream chunk progress to timeline
    progress?.({
      type: 'chunk',
      stage: 'chunk',
      chunkIndex: cIdx,
      totalChunks,
      cuts: chunkCuts,
      isFirst: cIdx === 0,
      isLast: cIdx === totalChunks - 1,
      nextSourceOffset: curSource,
      message: `⚡ [${cIdx + 1}/${totalChunks}] ${chunkCuts.length} кадр бэлэн боллоо!`
    });
  }

  progress?.({ stage: 'done', message: '✨ AI Скрипт Студи: Бүх эвлүүлэг бэлэн боллоо!' });

  return {
    ok: true,
    audioPath: audioFile,
    voiceDuration,
    videoDuration: video.duration,
    cuts: allCuts,
    sentences: rawSentences,
    nextSourceOffset: curSource,
    visionAIUsed,
    visionError
  };
}

module.exports = { buildScriptRecap };
