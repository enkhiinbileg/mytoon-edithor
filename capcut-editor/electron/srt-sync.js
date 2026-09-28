'use strict';
const path = require('node:path');
const ff = require('./ffmpeg');
const srtParser = require('./srt-parser');
const bilingualAlign = require('./bilingual-align');
const settings = require('./settings');
const visionSync = require('./vision-sync');

/**
 * Execute full SRT-to-Script Timeline Synchronization.
 */
async function syncTimelineWithSrt(spec, progress) {
  const {
    videoPath,
    srtPath,
    srtContent,
    voicePath,
    voiceOffset = 0,
    voiceDuration = null,
    scriptText: rawScriptText = '',
    scriptPath,
    videoOffset = 0,
    pacingMode = 'hybrid' // 'hybrid' | 'freeze' | 'motion'
  } = spec;

  let scriptText = rawScriptText || '';
  if (!scriptText && scriptPath && fs.existsSync(scriptPath)) {
    try {
      scriptText = fs.readFileSync(scriptPath, 'utf8');
    } catch {}
  }

  progress?.({ stage: 'start', message: '🔍 Бичлэг болон Англи хадмалыг шалгаж байна...' });

  // 1. Probe video & voice media
  const [video, audio] = await Promise.all([ff.probe(videoPath), ff.probe(voicePath)]);
  if (!video.hasVideo || video.duration <= 0) throw new Error('Сонгосон видео файл олдсонгүй эсвэл дүрсгүй байна.');
  if (!audio.hasAudio || audio.duration <= 0) throw new Error('Сонгосон voice аудио файл дуугүй байна.');

  const effVoiceDuration = (typeof voiceDuration === 'number' && voiceDuration > 0)
    ? Math.min(voiceDuration, Math.max(0.5, audio.duration - voiceOffset))
    : Math.max(0.5, audio.duration - voiceOffset);

  // 2. Parse English SRT & Reconstruct into Full Narrative Sentences
  progress?.({ stage: 'srt', message: '📜 Англи SRT хадмалыг уншиж бүтэн өгүүлбэрүүд болгон нэгтгэж байна...' });
  let rawEnglishSrt = [];
  if (srtPath) {
    rawEnglishSrt = srtParser.parseSrtFile(srtPath);
  } else if (srtContent) {
    rawEnglishSrt = srtParser.parseSrt(srtContent);
  }

  if (!rawEnglishSrt.length) {
    throw new Error('Англи SRT хадмал хоосон эсвэл буруу форматтай байна.');
  }

  // Intelligently merge 1.5s fragmented YouTube auto-subs into full narrative sentences
  const englishSrt = srtParser.reconstructSentences(rawEnglishSrt);

  // 3. Segment Mongolian Voice Narration
  progress?.({ stage: 'speech', message: '🎙️ Монгол ярианы өгүүлбэр, амьсгааг хэмжиж байна...' });
  let mongolianSegments = [];

  const apiKey = spec.geminiApiKey || settings.secret('geminiApiKey') || process.env.GEMINI_API_KEY || '';

  // If script text is provided, use natural sentence breaks timed by speech cadence
  if (scriptText && scriptText.trim().length > 20) {
    const rawSentences = scriptText
      .trim()
      .split(/(?<=[.!?\n])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);

    if (rawSentences.length >= 2) {
      // Divide voice duration proportionally by character length
      const totalChars = rawSentences.reduce((acc, s) => acc + s.length, 0);
      let curT = 0;
      mongolianSegments = rawSentences.map((s, idx) => {
        const dur = Math.max(1.2, (s.length / totalChars) * effVoiceDuration);
        const start = curT;
        const end = Math.min(effVoiceDuration, curT + dur);
        curT = end;
        return {
          id: idx,
          start: Math.round(start * 1000) / 1000,
          end: Math.round(end * 1000) / 1000,
          text: s
        };
      });
    }
  }

  // If no scriptText provided, but we have Gemini API key, transcribe the voice directly using Gemini!
  if (!mongolianSegments.length && apiKey) {
    try {
      progress?.({ stage: 'transcribe', message: '🎙️ AI: Монгол voice яриаг сонсож өгүүлбэрүүдийг бичиж байна...' });
      const tRes = await visionSync.transcribeVoiceWithGemini({
        voicePath,
        apiKey,
        startOffset: voiceOffset,
        duration: effVoiceDuration
      });
      if (tRes && Array.isArray(tRes.segments) && tRes.segments.length > 0) {
        mongolianSegments = tRes.segments.map((s, idx) => ({
          id: idx,
          start: Math.round(s.start * 1000) / 1000,
          end: Math.round(s.end * 1000) / 1000,
          text: s.text || s.visualEvent || `Өгүүлбэр ${idx + 1}`
        }));
      }
    } catch (tErr) {
      console.warn('[srt-sync] Gemini transcribe voice fallback:', tErr.message);
    }
  }

  // Fallback to high-precision speech-pause detection
  if (!mongolianSegments.length) {
    try {
      const raw = await ff.detectSpeechSegments(voicePath, {
        startOffset: voiceOffset,
        duration: effVoiceDuration,
        minSilence: 0.28,
        noise: '-30dB'
      });
      if (raw.length) {
        for (let idx = 0; idx < raw.length; idx++) {
          const s = raw[idx];
          const segStart = Math.max(0, Math.min(effVoiceDuration, s.start));
          const segEnd = Math.max(segStart + 0.3, Math.min(effVoiceDuration, s.end));
          const dur = segEnd - segStart;
          if (dur > 4.5) {
            const subCount = Math.max(2, Math.round(dur / 3.0));
            const subDur = dur / subCount;
            for (let k = 0; k < subCount; k++) {
              mongolianSegments.push({
                id: mongolianSegments.length,
                start: segStart + k * subDur,
                end: (k === subCount - 1) ? segEnd : segStart + (k + 1) * subDur,
                text: `Өгүүлбэр ${mongolianSegments.length + 1}`
              });
            }
          } else {
            mongolianSegments.push({
              id: mongolianSegments.length,
              start: segStart,
              end: segEnd,
              text: `Өгүүлбэр ${mongolianSegments.length + 1}`
            });
          }
        }
      }
    } catch {}
  }

  if (!mongolianSegments.length) {
    // Fallback simple chunks
    const chunkLen = 3.5;
    const n = Math.ceil(effVoiceDuration / chunkLen);
    for (let i = 0; i < n; i++) {
      mongolianSegments.push({
        id: i,
        start: i * chunkLen,
        end: Math.min(effVoiceDuration, (i + 1) * chunkLen),
        text: `Өгүүлбэр ${i + 1}`
      });
    }
  }

  // 4. Align Mongolian Segments with English SRT Blocks
  progress?.({ stage: 'aligning', message: '🤖 AI: Англи хадмал болон Монгол өгүүлбэрүүдийг харьцуулан холбож байна...' });
  let alignments = [];

  const hasRealScript = mongolianSegments.length > 0 && !mongolianSegments.every((s) => /^Өгүүлбэр \d+$/.test(s.text));

  if (hasRealScript) {
    alignments = await bilingualAlign.alignWithGemini({
      mongolianSegments,
      englishSrt,
      apiKey,
      model: spec.geminiModel || 'gemini-3.6-flash'
    });
  } else {
    // When no distinct Mongolian script text is available, the reconstructed English SRT scenes
    // serve as the master narrative timeline mapped proportionally to speech duration!
    const totalSrtDuration = Math.max(1, englishSrt[englishSrt.length - 1].end);
    const speedRatio = effVoiceDuration / totalSrtDuration;

    let curTimelineT = 0;
    alignments = englishSrt.map((scene, idx) => {
      const aStart = Math.round(curTimelineT * 1000) / 1000;
      const dur = Math.max(0.4, scene.duration * speedRatio);
      curTimelineT += dur;
      const aEnd = Math.round(Math.min(effVoiceDuration, curTimelineT) * 1000) / 1000;

      return {
        mongolianId: idx,
        mongolianText: `Үзэгдэл ${idx + 1}`,
        audioStart: aStart,
        audioEnd: aEnd,
        matchedSrtId: scene.id,
        englishText: scene.text,
        videoStart: scene.start,
        videoEnd: scene.end,
        confidence: 1.0,
        method: 'scene-master'
      };
    });
  }

  // 5. Generate Target Cuts & Timeline Specs
  progress?.({ stage: 'cutting', message: '✂️ Видеоны тайралтуудыг тооцоолж байна...' });

  const CHUNK_SIZE = 8;
  const allCuts = [];
  const totalChunks = Math.ceil(alignments.length / CHUNK_SIZE);
  let lastSourceEnd = 0;

  for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
    const chunkAligns = alignments.slice(cIdx * CHUNK_SIZE, (cIdx + 1) * CHUNK_SIZE);
    const chunkCuts = [];

    // Timestamps that require freeze frame holding
    const freezeTimestamps = [];

    for (let j = 0; j < chunkAligns.length; j++) {
      const align = chunkAligns[j];
      const globalIdx = allCuts.length + j;

      const tStart = (globalIdx === 0) ? 0 : align.audioStart;
      const nextAlign = (j < chunkAligns.length - 1)
        ? chunkAligns[j + 1]
        : (cIdx < totalChunks - 1 ? alignments[(cIdx + 1) * CHUNK_SIZE] : null);
      const tEnd = nextAlign ? nextAlign.audioStart : effVoiceDuration;
      const cutDur = Math.max(0.4, tEnd - tStart);

      const offsetSec = Number(videoOffset) || 0;
      let sStart = Math.max(0, Math.min(video.duration - 0.5, align.videoStart + offsetSec));

      const prevAlign = (j > 0) ? chunkAligns[j - 1] : (globalIdx > 0 ? alignments[globalIdx - 1] : null);
      const isSubCutOfSameScene = prevAlign && (align.matchedSrtId === prevAlign.matchedSrtId);

      // Only continue seamlessly from lastSourceEnd if this cut is a sub-slice of the SAME scene!
      // When moving to a new scene, it MUST cut cleanly to the new scene's videoStart.
      if (isSubCutOfSameScene && sStart < lastSourceEnd && (lastSourceEnd - sStart) < 15.0) {
        sStart = lastSourceEnd;
      }

      const sEnd = Math.max(sStart + 0.3, Math.min(video.duration - 0.2, align.videoEnd + offsetSec));

      // User Option 1B (Default): Pure dynamic video motion!
      // The video plays continuously starting from the exact SRT scene for the full duration
      // of the Mongolian speech, keeping the video completely fluid and animated without freezing.
      const motionEnd = Math.min(video.duration - 0.05, sStart + cutDur);
      const actualSourceEnd = (pacingMode === 'freeze') ? sEnd : motionEnd;
      const actualSourceDur = actualSourceEnd - sStart;
      lastSourceEnd = actualSourceEnd;

      let shouldFreeze = false;
      if (pacingMode === 'freeze' && cutDur > actualSourceDur + 0.6) {
        shouldFreeze = true;
        freezeTimestamps.push(actualSourceEnd);
      }

      chunkCuts.push({
        id: globalIdx,
        sourceStart: Math.round(sStart * 1000) / 1000,
        sourceEnd: Math.round(actualSourceEnd * 1000) / 1000,
        targetStart: Math.round(tStart * 1000) / 1000,
        targetEnd: Math.round(tEnd * 1000) / 1000,
        duration: Math.round(cutDur * 1000) / 1000,
        text: align.mongolianText ? align.mongolianText.slice(0, 48) : `Кадр ${globalIdx + 1}`,
        reason: align.englishText ? `[SRT #${align.matchedSrtId}] ${align.englishText.slice(0, 64)}` : '',
        shouldFreeze,
        freezeTs: actualSourceEnd
      });
    }

    // Extract freeze frames in batch only if freeze mode is explicitly requested
    let freezeMap = new Map();
    if (freezeTimestamps.length) {
      try {
        freezeMap = await ff.extractFreezeFrameBatch(videoPath, freezeTimestamps);
      } catch (fErr) {
        console.warn('[srt-sync] freeze batch fallback:', fErr.message);
      }
    }

    const processedChunkCuts = chunkCuts.map((c) => {
      const img = c.shouldFreeze ? (freezeMap.get(c.freezeTs) || null) : null;
      return {
        id: c.id,
        sourceStart: c.sourceStart,
        sourceEnd: c.sourceEnd,
        targetStart: c.targetStart,
        targetEnd: c.targetEnd,
        duration: c.duration,
        text: c.text,
        reason: c.reason,
        freeze: Boolean(img),
        freezeImagePath: img
      };
    });

    allCuts.push(...processedChunkCuts);

    // Stream chunk progress to timeline
    progress?.({
      type: 'chunk',
      stage: 'chunk',
      chunkIndex: cIdx,
      totalChunks,
      cuts: processedChunkCuts,
      isFirst: cIdx === 0,
      isLast: cIdx === totalChunks - 1,
      message: `⚡ [${cIdx + 1}/${totalChunks}] ${processedChunkCuts.length} кадр SRT-ээр амжилттай холбогдлоо!`
    });
  }

  const lastCut = allCuts[allCuts.length - 1];
  const nextSourceOffset = lastCut ? lastCut.sourceEnd : 0;

  return {
    ok: true,
    cuts: allCuts,
    totalSegments: allCuts.length,
    nextSourceOffset,
    alignmentsCount: alignments.length
  };
}

module.exports = {
  syncTimelineWithSrt
};
