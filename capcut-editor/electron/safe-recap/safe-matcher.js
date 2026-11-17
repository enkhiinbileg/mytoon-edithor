'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const safeProc = require('./safe-image-processor');

const uid = () => crypto.randomBytes(4).toString('hex');

/**
 * Splits a raw script into natural narration beats with estimated durations
 * (used when user previews storyboard BEFORE spending TTS credits).
 */
function splitTextToEstimatedBeats(scriptText, wordsPerSec = 2.3) {
  const clean = String(scriptText || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  // Strip optional ElevenLabs audio tags like [whispers] for visual timing estimation
  const rawSentences = clean
    .split(/(?<=[.!?…\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const beats = [];
  let cursor = 0;

  for (let i = 0; i < rawSentences.length; i++) {
    const text = rawSentences[i];
    const spoken = text.replace(/\[[^\]]+\]/g, '').trim();
    const words = spoken ? spoken.split(/\s+/).filter(Boolean).length : 2;
    const dur = Math.max(1.8, Math.min(9.0, Math.round((words / Math.max(1.2, wordsPerSec) + 0.45) * 100) / 100));
    const start = Math.round(cursor * 100) / 100;
    const end = Math.round((cursor + dur) * 100) / 100;
    beats.push({
      id: `beat_${i + 1}`,
      start,
      end,
      text
    });
    cursor = end;
  }

  return beats;
}

function determineSafeMotion(text = '', panel = {}, targetAspect = '16:9') {
  const clean = String(text || '').toLowerCase();
  const w = panel.sanitizedWidth || panel.width || 1080;
  const h = panel.sanitizedHeight || panel.height || 1080;
  const isTall = h / Math.max(1, w) >= 1.28;
  const isTightCrop = panel.safetyStatus === 'cropped' && panel.cropRect && panel.cropRect.h < 0.55;

  const isAction = /[!?!]/.test(text) || /(цохив|хашхирав|гүйлээ|гэнэт|цоч|ууртай|айдас|ширүүн)/i.test(clean);
  const isCalm = /(тайван|харж|бодов|бодож|гэв|хэлэв|шивнэ|аяархан|инээмсэг)/i.test(clean);

  if (isTightCrop) {
    return isAction ? 'zoom_in' : 'zoom_out';
  }
  if (isTall) return 'pan_down';
  if (isAction) return 'zoom_in';
  if (isCalm) return 'zoom_out';
  return targetAspect === '9:16' ? 'zoom_in' : 'zoom_out';
}

function buildSafeKeyframes(motion, duration, panel = {}) {
  const dur = Math.max(0.2, Number(duration) || 2.0);
  const isCropped = panel.safetyStatus === 'cropped';
  // Keep vertical pan tighter on cropped panels so motion stays comfortably around the face/safe subject
  const panMinY = isCropped ? 0.44 : 0.38;
  const panMaxY = isCropped ? 0.56 : 0.62;
  const panScale = isCropped ? 1.08 : 1.12;

  switch (motion) {
    case 'zoom_in':
      return [
        { id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 },
        { id: uid(), time: dur, scale: 1.16, x: 0.5, y: 0.5 }
      ];
    case 'zoom_out':
      return [
        { id: uid(), time: 0, scale: 1.16, x: 0.5, y: 0.5 },
        { id: uid(), time: dur, scale: 1.0, x: 0.5, y: 0.5 }
      ];
    case 'pan_down':
      return [
        { id: uid(), time: 0, scale: panScale, x: 0.5, y: panMinY },
        { id: uid(), time: dur, scale: panScale, x: 0.5, y: panMaxY }
      ];
    case 'pan_up':
      return [
        { id: uid(), time: 0, scale: panScale, x: 0.5, y: panMaxY },
        { id: uid(), time: dur, scale: panScale, x: 0.5, y: panMinY }
      ];
    case 'static':
    default:
      return [{ id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 }];
  }
}

function buildContinuousSafePlan({ beats, assignedPanels, motions, reasons, fallbackFlags, audioDuration, aspect = '16:9' }) {
  const plan = [];
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const panel = assignedPanels[i] || assignedPanels[assignedPanels.length - 1];
    const clipStart = i === 0 ? 0 : plan[i - 1].end;
    let clipEnd;
    if (i < beats.length - 1) {
      clipEnd = Math.max(clipStart + 0.25, beats[i + 1].start);
    } else {
      clipEnd = Math.max(clipStart + 0.25, beat.end, audioDuration || beat.end);
    }

    const duration = Math.round((clipEnd - clipStart) * 1000) / 1000;
    const motion = motions[i] || determineSafeMotion(beat.text, panel, aspect);
    const keyframes = buildSafeKeyframes(motion, duration, panel);

    plan.push({
      id: uid(),
      beatId: beat.id || `beat_${i + 1}`,
      start: clipStart,
      end: clipEnd,
      duration,
      text: beat.text || '',
      panelId: panel.id,
      imagePath: panel.path,
      sanitizedPath: panel.sanitizedRenderPath || panel.sanitizedThumbPath || panel.path,
      imageWidth: panel.sanitizedWidth || panel.width,
      imageHeight: panel.sanitizedHeight || panel.height,
      imageName: panel.name,
      safetyStatus: panel.safetyStatus || 'safe',
      cropRect: panel.cropRect || null,
      censorBoxes: Array.isArray(panel.censorBoxes) ? panel.censorBoxes : [],
      needsReview: Boolean(panel.needsReview),
      safetyReason: panel.safetyReason || '',
      isFallback: Boolean(fallbackFlags?.[i]),
      motion,
      aspect,
      confidence: fallbackFlags?.[i] ? 0.65 : 0.9,
      keyframes,
      aiReason: reasons?.[i] || ''
    });
  }
  return plan;
}

function buildSafeSequentialPlan(beats, panels, audioDuration, aspect = '16:9') {
  const safePanels = panels.filter((p) => p.safetyStatus !== 'excluded');
  if (!safePanels.length) {
    throw new Error('Аюулгүй (SFW) зураг үлдсэнгүй. Хэрэгтэй кадрууд дээр гараар Crop эсвэл Blur тохируулна уу.');
  }

  const assignedPanels = [];
  const motions = [];
  const reasons = [];
  const fallbackFlags = [];

  for (let i = 0; i < beats.length; i++) {
    const idx = Math.min(safePanels.length - 1, Math.floor((i * safePanels.length) / Math.max(1, beats.length)));
    const panel = safePanels[idx];
    assignedPanels.push(panel);
    motions.push(determineSafeMotion(beats[i].text, panel, aspect));
    reasons.push(panel.safetyStatus === 'cropped' ? 'Цэвэрлэсэн Crop (дараалал)' : 'Дарааллын аюулгүй кадр');
    fallbackFlags.push(false);
  }

  return buildContinuousSafePlan({ beats, assignedPanels, motions, reasons, fallbackFlags, audioDuration, aspect });
}

function isSafetyBlockError(status, errMsg = '', body = null) {
  const finishReason = body?.candidates?.[0]?.finishReason || '';
  const blockReason = body?.promptFeedback?.blockReason || '';
  if (/SAFETY|PROHIBITED|SEXUALLY_EXPLICIT|IMAGE_SAFETY/i.test(`${finishReason} ${blockReason}`)) return true;
  if (/safety|prohibited|explicit|blocked/i.test(String(errMsg))) return true;
  return status === 400 && /image|safety/i.test(String(errMsg));
}

async function callGeminiSafeBatch({ subBatch, panelBatch, thumbMap, apiKey, model }) {
  const imageParts = [];
  const validPanels = [];

  for (const p of panelBatch) {
    const thumbPath = thumbMap.get(p.id) || p.sanitizedThumbPath || p.path;
    if (!thumbPath || !fs.existsSync(thumbPath)) continue;
    try {
      const b64 = fs.readFileSync(thumbPath).toString('base64');
      imageParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
      validPanels.push(p);
    } catch {}
  }

  if (!imageParts.length) return { ok: false, safetyBlocked: false, matches: null };

  const captionList = subBatch
    .map((s, idx) => `[Beat_${idx}]: "${String(s.text || '').replace(/"/g, "'")}"`)
    .join('\n');

  const promptText = `You are a professional SFW webtoon/manhwa recap video editor.
All ${validPanels.length} panels below (Index 0 to ${validPanels.length - 1}) have already been pre-cropped or blurred locally to remove explicit elements.
Narration beats (in chronological story order):
${captionList}

For EACH beat [Beat_0], [Beat_1], etc.:
1. "panelIndex": choose the panel index (0 to ${validPanels.length - 1}) that best illustrates the action, dialogue, or emotion in the story.
   - If the narration describes an intimate or tense moment, select the best character facial reaction, eye close-up, hand/gesture, or atmospheric background panel.
2. "motion": choose camera movement from ["zoom_in", "zoom_out", "pan_down", "pan_up", "static"].
3. "reason": a very short Mongolian note (max 6 words) explaining why this panel matches the beat.

Return ONLY valid JSON array:
[
  { "beatIndex": 0, "panelIndex": 0, "motion": "zoom_in", "reason": "Дүрийн царайны хувирал таарч байна" }
]`;

  const candidates = Array.from(
    new Set([model || 'gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-flash-latest'].filter(Boolean))
  );

  for (const mName of candidates) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mName)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        signal: AbortSignal.timeout(65000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [...imageParts, { text: promptText }] }],
          generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
        })
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error?.message || `HTTP ${res.status}`;
        if (isSafetyBlockError(res.status, msg, body)) {
          return { ok: false, safetyBlocked: true, matches: null, error: msg };
        }
        continue;
      }

      const finish = body?.candidates?.[0]?.finishReason;
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text && isSafetyBlockError(200, '', body)) {
        return { ok: false, safetyBlocked: true, matches: null, error: finish || 'SAFETY' };
      }
      if (!text) continue;

      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return { ok: true, safetyBlocked: false, matches: parsed, validPanels };
      }
    } catch (err) {
      if (isSafetyBlockError(0, err?.message)) {
        return { ok: false, safetyBlocked: true, matches: null, error: err.message };
      }
    }
  }

  return { ok: false, safetyBlocked: false, matches: null };
}

/**
 * If a Gemini batch triggers SAFETY on an edge-case panel despite local filtering,
 * recursively splits the panel set to isolate and skip only the blocked panel(s).
 */
async function matchBatchWithSafetySplit({ subBatch, panelBatch, thumbMap, apiKey, model, blockedIds }) {
  const res = await callGeminiSafeBatch({ subBatch, panelBatch, thumbMap, apiKey, model });
  if (res.ok) return res;
  if (!res.safetyBlocked) return res;

  if (panelBatch.length <= 1) {
    if (panelBatch[0]) blockedIds.add(panelBatch[0].id);
    return { ok: false, safetyBlocked: true, matches: null };
  }

  const mid = Math.ceil(panelBatch.length / 2);
  const left = await matchBatchWithSafetySplit({
    subBatch,
    panelBatch: panelBatch.slice(0, mid),
    thumbMap,
    apiKey,
    model,
    blockedIds
  });
  if (left.ok) return left;

  return matchBatchWithSafetySplit({
    subBatch,
    panelBatch: panelBatch.slice(mid),
    thumbMap,
    apiKey,
    model,
    blockedIds
  });
}

async function alignSafeImagesToBeats({
  beats,
  panels,
  apiKey,
  model = 'gemini-2.5-flash',
  audioDuration = 0,
  aspectRatio = '16:9',
  cacheDir,
  useAi = true,
  onProgress
}) {
  if (!Array.isArray(beats) || !beats.length) {
    throw new Error('Скриптийн өгүүлбэр эсвэл хадмал олдсонгүй.');
  }
  const sortedBeats = [...beats]
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end >= b.start)
    .sort((a, b) => a.start - b.start);

  const safePanels = (panels || []).filter((p) => p.safetyStatus !== 'excluded');
  if (!safePanels.length) {
    throw new Error('Аюулгүй (SFW) кадр үлдсэнгүй. Зарим кадр дээр Crop/Blur тохируулж сэргээнэ үү.');
  }

  onProgress?.('Цэвэрлэгдсэн кадруудын урьдчилсан дүрсийг бэлдэж байна...', 10);
  const thumbDir = path.join(cacheDir, 'sanitized-thumbs');
  const thumbMap = new Map();

  for (let i = 0; i < safePanels.length; i++) {
    const p = safePanels[i];
    try {
      const mat = await safeProc.materializeSanitizedImage({
        imagePath: p.path,
        origW: p.width,
        origH: p.height,
        cropRect: p.cropRect,
        censorBoxes: p.censorBoxes,
        outDir: thumbDir,
        maxWidth: 480,
        quality: 3
      });
      thumbMap.set(p.id, mat.path);
    } catch {
      thumbMap.set(p.id, p.sanitizedThumbPath || p.path);
    }
  }

  if (!useAi || !apiKey) {
    onProgress?.('AI түлхүүр алга эсвэл унтраалттай тул дарааллаар тааруулж байна...', 70);
    const plan = buildSafeSequentialPlan(sortedBeats, safePanels, audioDuration, aspectRatio);
    onProgress?.('Бэлэн боллоо!', 100);
    return { plan, blockedPanelIds: [] };
  }

  const BATCH_SIZE = 6;
  const assignedPanels = new Array(sortedBeats.length);
  const motions = new Array(sortedBeats.length);
  const reasons = new Array(sortedBeats.length);
  const fallbackFlags = new Array(sortedBeats.length).fill(false);
  const blockedIds = new Set();

  for (let b = 0; b < sortedBeats.length; b += BATCH_SIZE) {
    const subBatch = sortedBeats.slice(b, b + BATCH_SIZE);
    const startP = Math.max(0, Math.floor((b / sortedBeats.length) * safePanels.length) - 2);
    const endP = Math.min(safePanels.length, Math.ceil(((b + BATCH_SIZE) / sortedBeats.length) * safePanels.length) + 3);
    const panelBatch = safePanels.slice(startP, Math.max(startP + 3, endP)).filter((p) => !blockedIds.has(p.id));

    onProgress?.(
      `Үйл явдлаар тааруулж байна (${Math.min(sortedBeats.length, b + BATCH_SIZE)}/${sortedBeats.length})...`,
      Math.round(18 + (b / sortedBeats.length) * 75)
    );

    const res = panelBatch.length
      ? await matchBatchWithSafetySplit({ subBatch, panelBatch, thumbMap, apiKey, model, blockedIds })
      : { ok: false, matches: null };

    const usedPanels = res.validPanels || panelBatch;

    for (let i = 0; i < subBatch.length; i++) {
      const globalIdx = b + i;
      const beat = subBatch[i];
      const match = Array.isArray(res.matches) ? res.matches.find((m) => m.beatIndex === i) : null;

      let chosen = null;
      let isFallback = false;
      if (match && typeof match.panelIndex === 'number' && usedPanels[match.panelIndex] && !blockedIds.has(usedPanels[match.panelIndex].id)) {
        chosen = usedPanels[match.panelIndex];
      } else {
        // Fallback to nearest non-blocked safe panel
        const approxIdx = Math.min(safePanels.length - 1, Math.floor((globalIdx * safePanels.length) / sortedBeats.length));
        chosen =
          safePanels.slice(approxIdx).find((p) => !blockedIds.has(p.id)) ||
          safePanels.find((p) => !blockedIds.has(p.id)) ||
          safePanels[0];
        isFallback = true;
      }

      let motion = determineSafeMotion(beat.text, chosen, aspectRatio);
      if (match && ['zoom_in', 'zoom_out', 'pan_down', 'pan_up', 'static'].includes(match.motion)) {
        // Prevent pan_down/pan_up on tight cropped face panels
        const isTightCrop = chosen.safetyStatus === 'cropped' && chosen.cropRect && chosen.cropRect.h < 0.55;
        if (!isTightCrop || !match.motion.startsWith('pan_')) {
          motion = match.motion;
        }
      }

      assignedPanels[globalIdx] = chosen;
      motions[globalIdx] = motion;
      reasons[globalIdx] = (match?.reason && String(match.reason).trim()) || (isFallback ? 'Аюулгүй орлуулалт' : 'Үйл явдлын тааруулалт');
      fallbackFlags[globalIdx] = isFallback;
    }
  }

  onProgress?.('Цэвэр төлөвлөгөө бэлэн боллоо!', 100);
  const plan = buildContinuousSafePlan({
    beats: sortedBeats,
    assignedPanels,
    motions,
    reasons,
    fallbackFlags,
    audioDuration,
    aspect: aspectRatio
  });

  return { plan, blockedPanelIds: Array.from(blockedIds) };
}

module.exports = {
  splitTextToEstimatedBeats,
  determineSafeMotion,
  buildSafeKeyframes,
  buildContinuousSafePlan,
  buildSafeSequentialPlan,
  alignSafeImagesToBeats
};
