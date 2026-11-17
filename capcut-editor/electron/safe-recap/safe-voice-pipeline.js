'use strict';

const fs = require('node:fs');
const path = require('node:path');
const scriptStudio = require('../script-studio');
const audioScriptAlign = require('../audio-script-align');
const whisper = require('../whisper');
const ff = require('../ffmpeg');
const sessionStore = require('./safe-session-store');

let corePromise = null;
function loadAlignCore() {
  if (!corePromise) corePromise = import('../script-align-core.mjs');
  return corePromise;
}

function getAvailableWhisperModels() {
  try {
    const st = whisper.status ? whisper.status() : { available: false, models: [] };
    return {
      available: Boolean(st.available),
      models: (st.models || []).map((m) => ({
        id: m.id,
        label: m.label,
        installed: Boolean(m.installed),
        note: m.note
      }))
    };
  } catch {
    return { available: false, models: [] };
  }
}

function sanitizeBeats(clips, totalDuration) {
  const maxDur = Math.max(0.2, Number(totalDuration) || 0);
  const items = (Array.isArray(clips) ? clips : [])
    .map((c, idx) => {
      const text = String(c?.style?.text ?? c?.text ?? '').trim();
      if (!text) return null;
      const start = Math.max(0, Number(c.start) || 0);
      const dur =
        typeof c.outPoint === 'number' && typeof c.inPoint === 'number'
          ? Math.max(0.15, c.outPoint - c.inPoint)
          : Math.max(0.15, (Number(c.end) || start + 1) - start);
      return { id: `beat_${idx + 1}`, start, dur, text };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    let start = cur.start;
    if (out.length > 0 && start < out[out.length - 1].end) {
      start = out[out.length - 1].end;
    }
    const nextStart = items[i + 1] ? items[i + 1].start : maxDur;
    let end = Math.min(maxDur > 0 ? maxDur : start + cur.dur, Math.max(start + 0.15, start + cur.dur), Math.max(start + 0.15, nextStart));
    if (maxDur > 0 && start >= maxDur - 0.05) {
      if (out.length > 0) {
        out[out.length - 1].text = `${out[out.length - 1].text} ${cur.text}`.trim();
        out[out.length - 1].end = Math.round(maxDur * 1000) / 1000;
      }
      continue;
    }
    if (end <= start) end = start + 0.15;
    out.push({
      id: `beat_${out.length + 1}`,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text: cur.text
    });
  }
  return out;
}

/**
 * Fix/re-align existing draft subtitles (from Whisper or SRT) against the clean original script.
 */
async function fixSubtitlesWithScript({ scriptText, draftBeats, audioDuration = 0 }) {
  if (!scriptText || !String(scriptText).trim()) {
    throw new Error('Хадмалыг засахын тулд эх скриптээ оруулна уу.');
  }
  if (!Array.isArray(draftBeats) || !draftBeats.length) {
    throw new Error('Засах хадмал алга байна.');
  }

  const core = await loadAlignCore();
  const { text: cleanScript } = core.clearTagsFromScript(String(scriptText));

  const asClips = draftBeats.map((b, idx) => ({
    id: b.id || `draft_${idx + 1}`,
    kind: 'text',
    trackId: 'o1',
    start: Math.max(0, Number(b.start) || 0),
    inPoint: 0,
    outPoint: Math.max(0.1, (Number(b.end) || 0) - (Number(b.start) || 0) || 1.0),
    style: { text: String(b.text || '').trim() }
  }));

  const aligned = core.alignScriptToClips(cleanScript, asClips, { mode: 'full' });
  const reflowed = core.reflowSentenceBoundaries(aligned.updatedClips);
  const totalDur = audioDuration || Math.max(...draftBeats.map((b) => Number(b.end) || 0), 1);
  const fixedBeats = sanitizeBeats(reflowed.updatedClips, totalDur);

  return {
    ok: true,
    beats: fixedBeats.length ? fixedBeats : draftBeats,
    reflowedCount: reflowed.fixedCount || 0,
    message: aligned.message || 'Скриптээр хадмалыг заслаа'
  };
}

/**
 * Full voice + subtitle workflow for Safe Webtoon Recap:
 * 1. Script -> Voice (ElevenLabs TTS, optional Mongolian auto-tagging)
 * 2. Voice -> Whisper Subtitles (Groq Large v3 or local installed Whisper)
 * 3. Subtitles -> Fix words & sentence boundaries using the original clean script
 */
async function buildVoiceAndFixedSubtitles({
  app,
  sessionId = 'default',
  scriptText,
  voiceId = 'TX3LPaxmHKxFdv7VOQHJ',
  modelId = 'eleven_v4',
  stability = 0.5,
  similarity = 0.75,
  speed = 1.0,
  autoTagScript = false,
  whisperModel = '',
  onProgress
}) {
  if (!scriptText || !String(scriptText).trim()) {
    throw new Error('Скрипт текст хоосон байна.');
  }

  const core = await loadAlignCore();
  const sessionCacheDir = sessionStore.getCacheDir(app, sessionId);
  const voiceOutDir = path.join(sessionCacheDir, 'voice-parts');
  fs.mkdirSync(voiceOutDir, { recursive: true });

  // Stage 1: Script -> TTS Voice
  let ttsScript = String(scriptText).trim();
  if (autoTagScript) {
    onProgress?.('tts', '✨ Скриптэд эмоци/амьсгааны таг нэмж байна...', 5);
    const tagged = core.autoTagMongolianScript(ttsScript, { intensity: 'balanced', clearExisting: false });
    ttsScript = tagged.text;
  }

  onProgress?.('tts', '🎙️ 1/3: Скриптээс ElevenLabs дуу хоолой үүсгэж байна...', 12);
  const ttsRes = await scriptStudio.buildScriptRecap(
    {
      scriptText: ttsScript,
      voiceId,
      modelId,
      stability,
      similarity,
      speed,
      audioOnly: true,
      mode: 'audio_only',
      outDir: voiceOutDir
    },
    (p) => onProgress?.('tts', p.message || '🎙️ Дуу хоолой үүсгэж байна...', 25)
  );

  if (!ttsRes?.ok || !ttsRes.audioPath || !fs.existsSync(ttsRes.audioPath)) {
    throw new Error(ttsRes?.error || 'ElevenLabs дуу хоолой үүсгэж чадсангүй.');
  }

  let duration = Number(ttsRes.voiceDuration) || 0;
  try {
    const p = await ff.probe(ttsRes.audioPath);
    if (p.duration > 0) duration = p.duration;
  } catch {}

  const ttsFallbackBeats = (ttsRes.sentences || []).map((s, idx) => ({
    id: `tts_${idx + 1}`,
    start: s.start,
    end: s.end,
    text: s.text
  }));

  // Stage 2: Voice -> Whisper Subtitles
  const wInfo = getAvailableWhisperModels();
  const installedModels = wInfo.models.filter((m) => m.installed);
  let chosenWhisper = whisperModel;
  if (!chosenWhisper || !installedModels.some((m) => m.id === chosenWhisper)) {
    chosenWhisper =
      installedModels.find((m) => m.id === 'groq-whisper-large-v3')?.id ||
      installedModels[0]?.id ||
      '';
  }

  let draftBeats = [];
  let subtitleMethod = 'tts-timestamps';
  let whisperWarning = '';

  if (chosenWhisper) {
    onProgress?.('whisper', `⚡ 2/3: Үүссэн дуунаас Whisper (${chosenWhisper})-ээр хадмал таньж байна...`, 52);
    try {
      const alignRes = await audioScriptAlign.alignAudioWithScript(
        {
          audioPath: ttsRes.audioPath,
          scriptText: '',
          useWhisper: true,
          whisperModel: chosenWhisper,
          forceFresh: true
        },
        (p) => {
          const pct = typeof p.pct === 'number' ? 52 + Math.round(p.pct * 0.25) : 65;
          onProgress?.('whisper', p.message || '⚡ Whisper яриа таньж байна...', pct);
        }
      );

      if (alignRes?.ok && Array.isArray(alignRes.segments) && alignRes.segments.length > 0) {
        const compacted = core.layoutCaptions(alignRes.segments);
        draftBeats = compacted.map((seg, idx) => ({
          id: `w_${idx + 1}`,
          start: Math.max(0, Number(seg.start) || 0),
          end: Math.max(0.15, Number(seg.end) || (Number(seg.start) || 0) + (Number(seg.duration) || 1)),
          text: String(seg.text || '').trim()
        })).filter((b) => b.text);
        subtitleMethod = `whisper(${chosenWhisper})`;
      }
    } catch (wErr) {
      whisperWarning = wErr?.message || String(wErr);
    }
  } else {
    whisperWarning = 'Groq түлхүүр эсвэл локал Whisper загвар суугаагүй тул TTS timestamp ашиглалаа.';
  }

  if (!draftBeats.length) {
    draftBeats = ttsFallbackBeats;
  }

  // Stage 3: Fix Subtitles using the clean original script
  onProgress?.('fix', '📝 3/3: Хадмалыг эх скриптээрээ цэвэрлэн засаж байна...', 85);
  let fixedBeats = draftBeats;
  let fixMessage = '';
  try {
    const fixedRes = await fixSubtitlesWithScript({
      scriptText,
      draftBeats,
      audioDuration: duration
    });
    if (fixedRes.ok && fixedRes.beats.length > 0) {
      fixedBeats = fixedRes.beats;
      subtitleMethod = `${subtitleMethod}+script-fix`;
      fixMessage = fixedRes.message;
    }
  } catch (fErr) {
    fixMessage = fErr?.message || '';
  }

  onProgress?.('done', `✓ Дуу + Whisper + Скрипт засвар бүрэн дууслаа (${fixedBeats.length} хадмал)!`, 100);

  return {
    ok: true,
    audioPath: ttsRes.audioPath,
    duration,
    draftBeats,
    beats: fixedBeats,
    whisperModelUsed: chosenWhisper,
    subtitleMethod,
    fixMessage,
    whisperWarning
  };
}

module.exports = {
  getAvailableWhisperModels,
  fixSubtitlesWithScript,
  buildVoiceAndFixedSubtitles
};
