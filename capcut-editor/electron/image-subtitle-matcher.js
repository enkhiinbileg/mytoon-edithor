'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');

const uid = () => Math.random().toString(36).slice(2, 9);

/**
 * Creates lightweight thumbnails (max dimension 400px) for Gemini Vision.
 */
async function createGeminiThumb(imagePath, thumbDir) {
  const hash = require('node:crypto').createHash('md5').update(imagePath).digest('hex').slice(0, 8);
  const outPath = path.join(thumbDir, `thumb_${hash}.jpg`);
  if (fs.existsSync(outPath)) {
    return outPath;
  }

  await new Promise((resolve) => {
    execFile(ff.FFMPEG, [
      '-v', 'error',
      '-y',
      '-i', imagePath,
      '-vf', 'scale=400:-1',
      '-q:v', '3',
      outPath
    ], (err) => {
      if (err) resolve(imagePath);
      else resolve(outPath);
    });
  });

  return outPath;
}

/**
 * Determines camera motion based on image dimensions and subtitle text.
 */
function determineMotion(text = '', width = 800, height = 600, targetAspect = '16:9') {
  const clean = text.toLowerCase();
  const isTall = height / width >= 1.25;

  const isAction = /[!?!]/.test(text) || /(цохив|хашхирав|гүйлээ|үх|тулаан|аймаар|хурдан|цочсон|гэнэт|сэлэм|буу)/i.test(clean);
  const isCalm = /(тайван|харж байв|бодов|бодож|гэв|хэлэв|маргааш|эхлэв|байшин|хот)/i.test(clean);

  if (targetAspect === '9:16') {
    if (isTall) return 'pan_down';
    if (isAction) return 'zoom_in';
    return isCalm ? 'zoom_out' : 'zoom_in';
  } else {
    // 16:9
    if (isTall) return 'pan_down';
    if (isAction) return 'zoom_in';
    return isCalm ? 'zoom_out' : 'zoom_in';
  }
}

/**
 * Build keyframes for Ken Burns motion based on aspect ratio and motion preset.
 */
function buildKeyframesForMotion(motion, duration, aspect = '16:9') {
  const dur = Math.max(0.1, duration);
  const kfs = [];

  switch (motion) {
    case 'zoom_in':
      kfs.push({ id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 });
      kfs.push({ id: uid(), time: dur, scale: 1.18, x: 0.5, y: 0.5 });
      break;
    case 'zoom_out':
      kfs.push({ id: uid(), time: 0, scale: 1.18, x: 0.5, y: 0.5 });
      kfs.push({ id: uid(), time: dur, scale: 1.0, x: 0.5, y: 0.5 });
      break;
    case 'pan_down':
      kfs.push({ id: uid(), time: 0, scale: 1.12, x: 0.5, y: 0.38 });
      kfs.push({ id: uid(), time: dur, scale: 1.12, x: 0.5, y: 0.62 });
      break;
    case 'pan_up':
      kfs.push({ id: uid(), time: 0, scale: 1.12, x: 0.5, y: 0.62 });
      kfs.push({ id: uid(), time: dur, scale: 1.12, x: 0.5, y: 0.38 });
      break;
    case 'static':
    default:
      kfs.push({ id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 });
      break;
  }

  return kfs;
}

/**
 * Builds a 100% continuous, gap-free timeline plan.
 * Absolutely NO black frames between subtitles or at the start/end!
 */
function buildContinuousPlan({ subtitles, assignedPanels, motions, audioDuration, aspect = '16:9' }) {
  const subCount = subtitles.length;
  const plan = [];

  for (let i = 0; i < subCount; i++) {
    const sub = subtitles[i];
    const panel = assignedPanels[i] || assignedPanels[assignedPanels.length - 1];

    // Clip 0 starts at 0.0s; subsequent clips start exactly where previous ended
    const clipStart = (i === 0) ? 0 : plan[i - 1].end;

    // Clip extends seamlessly until the next subtitle starts!
    let clipEnd;
    if (i < subCount - 1) {
      clipEnd = Math.max(clipStart + 0.2, subtitles[i + 1].start);
    } else {
      // Last clip covers all the way to audio end
      clipEnd = Math.max(clipStart + 0.2, sub.end, audioDuration || sub.end);
    }

    const duration = clipEnd - clipStart;
    const motion = motions[i] || determineMotion(sub.text, panel.width, panel.height, aspect);
    const keyframes = buildKeyframesForMotion(motion, duration, aspect);

    plan.push({
      id: uid(),
      subtitleId: sub.id || `sub_${i}`,
      start: clipStart,
      end: clipEnd,
      duration,
      text: sub.text || '',
      panelId: panel.id,
      imagePath: panel.path,
      imageWidth: panel.width,
      imageHeight: panel.height,
      imageName: panel.name,
      motion,
      aspect,
      confidence: 0.9,
      keyframes
    });
  }

  return plan;
}

/**
 * Strict chronological sequential matching.
 * Maps panels smoothly in order from start to finish.
 */
function runSequentialMatching(subtitles, panels, audioDuration, aspect = '16:9') {
  if (!panels.length || !subtitles.length) return [];

  const panelCount = panels.length;
  const subCount = subtitles.length;
  const assignedPanels = [];
  const motions = [];

  for (let i = 0; i < subCount; i++) {
    const sub = subtitles[i];
    // Map panel index smoothly across total subtitles
    const pIdx = Math.min(panelCount - 1, Math.floor(i * (panelCount / subCount)));
    const panel = panels[pIdx];
    assignedPanels.push(panel);
    motions.push(determineMotion(sub.text, panel.width, panel.height, aspect));
  }

  return buildContinuousPlan({
    subtitles,
    assignedPanels,
    motions,
    audioDuration,
    aspect
  });
}

/**
 * Gemini Vision Semantic Matcher.
 * Matches captions to panels by analyzing visual content and mood.
 */
async function runGeminiVisionMatching({
  subtitles,
  panels,
  apiKey,
  audioDuration,
  model = 'gemini-2.5-flash',
  aspect = '16:9',
  onProgress
}) {
  if (!apiKey || !panels.length || !subtitles.length) {
    return runSequentialMatching(subtitles, panels, audioDuration, aspect);
  }

  onProgress?.('AI Gemini Vision бэлтгэж байна...', 10);
  const thumbDir = path.join(os.tmpdir(), `gemini-thumbs-${Date.now()}`);
  fs.mkdirSync(thumbDir, { recursive: true });

  const BATCH_SIZE = 6;
  const assignedPanels = new Array(subtitles.length);
  const motions = new Array(subtitles.length);

  for (let b = 0; b < subtitles.length; b += BATCH_SIZE) {
    const subBatch = subtitles.slice(b, b + BATCH_SIZE);
    const startImgIdx = Math.max(0, Math.floor((b / subtitles.length) * panels.length) - 1);
    const endImgIdx = Math.min(panels.length, Math.ceil(((b + BATCH_SIZE) / subtitles.length) * panels.length) + 2);
    const panelBatch = panels.slice(startImgIdx, Math.max(startImgIdx + 2, endImgIdx));

    onProgress?.(`AI задлан шинжилж байна (${Math.min(subtitles.length, b + BATCH_SIZE)}/${subtitles.length})...`,
      Math.round(15 + (b / subtitles.length) * 70)
    );

    const imageParts = [];
    for (let pIdx = 0; pIdx < panelBatch.length; pIdx++) {
      const p = panelBatch[pIdx];
      try {
        const thumbPath = await createGeminiThumb(p.path, thumbDir);
        const b64 = fs.readFileSync(thumbPath).toString('base64');
        imageParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: b64
          }
        });
      } catch (e) {
        console.warn('Failed to load thumb for Gemini:', p.path, e);
      }
    }

    const captionListPrompt = subBatch.map((s, idx) =>
      `[Cap_${idx}]: "${s.text.replace(/"/g, "'")}"`
    ).join('\n');

    const promptText = `You are an expert anime/manga recap video editor.
Here are ${imageParts.length} comic panels in story order (Index 0 to ${imageParts.length - 1}).
Here are the narration captions:
${captionListPrompt}

For each caption [Cap_0], [Cap_1], etc., identify:
1. "panelIndex": which image panel (0 to ${imageParts.length - 1}) best matches the visual action or scene.
2. "motion": best camera movement from: ["zoom_in", "zoom_out", "pan_down", "pan_up", "static"].

Respond ONLY with a JSON array:
[
  { "capIndex": 0, "panelIndex": 0, "motion": "zoom_in" },
  ...
]`;

    let batchMatches = null;
    const candidateModels = [model || 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

    for (const mName of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const payload = {
          contents: [
            {
              role: 'user',
              parts: [
                ...imageParts,
                { text: promptText }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(65000)
        });

        if (res.ok) {
          const body = await res.json();
          const candidateText = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          batchMatches = JSON.parse(candidateText.replace(/```json/g, '').replace(/```/g, '').trim());
          if (Array.isArray(batchMatches)) break;
        } else {
          const errBody = await res.json().catch(() => ({}));
          console.warn(`Gemini model ${mName} HTTP ${res.status}:`, errBody?.error?.message || '');
        }
      } catch (err) {
        console.warn(`Gemini model ${mName} attempt failed:`, err.message);
      }
    }

    // Assign panels for this batch
    for (let i = 0; i < subBatch.length; i++) {
      const globalIdx = b + i;
      const sub = subBatch[i];
      const match = Array.isArray(batchMatches) ? batchMatches.find((m) => m.capIndex === i) : null;

      let chosenPanel = panelBatch[Math.min(panelBatch.length - 1, i)];
      let chosenMotion = determineMotion(sub.text, chosenPanel.width, chosenPanel.height, aspect);

      if (match && typeof match.panelIndex === 'number' && panelBatch[match.panelIndex]) {
        chosenPanel = panelBatch[match.panelIndex];
        if (['zoom_in', 'zoom_out', 'pan_down', 'pan_up', 'static'].includes(match.motion)) {
          chosenMotion = match.motion;
        }
      }

      assignedPanels[globalIdx] = chosenPanel;
      motions[globalIdx] = chosenMotion;
    }
  }

  // Cleanup thumbs
  try {
    fs.rmSync(thumbDir, { recursive: true, force: true });
  } catch {}

  onProgress?.('Бүрэн тааруулж дууслаа!', 100);

  return buildContinuousPlan({
    subtitles,
    assignedPanels,
    motions,
    audioDuration,
    aspect
  });
}

/**
 * Main coordinator function.
 */
async function alignImagesToSubtitles({
  subtitles,
  panels,
  audioDuration,
  aspectRatio = '16:9',
  useAi = true,
  apiKey,
  model,
  onProgress
}) {
  if (!panels || !panels.length) {
    throw new Error('Ямар ч зураг олдсонгүй. Зургийн хавтас эсвэл зурагнуудаа сонгоно уу.');
  }
  if (!subtitles || !subtitles.length) {
    throw new Error('Хадмалын мөрүүд олдсонгүй.');
  }

  // Clean and strictly sort subtitles by start time
  const sortedSubs = [...subtitles]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start);

  if (!sortedSubs.length) {
    throw new Error('Хадмалын эхлэх, дуусах хугацаа буруу байна.');
  }

  if (useAi && apiKey) {
    try {
      return await runGeminiVisionMatching({
        subtitles: sortedSubs,
        panels,
        apiKey,
        audioDuration,
        model,
        aspect: aspectRatio,
        onProgress
      });
    } catch (err) {
      console.warn('Gemini matching failed, falling back to sequential:', err);
    }
  }

  onProgress?.('Зургуудыг дарааллаар нь тааруулж байна...', 50);
  const plan = runSequentialMatching(sortedSubs, panels, audioDuration, aspectRatio);
  onProgress?.('Бэлэн боллоо!', 100);
  return plan;
}

module.exports = {
  determineMotion,
  buildKeyframesForMotion,
  buildContinuousPlan,
  runSequentialMatching,
  runGeminiVisionMatching,
  alignImagesToSubtitles
};
