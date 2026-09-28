'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');

/**
 * Extract dense, high-quality keyframes across a time window using FFmpeg.
 * Combines abrupt scene cuts (panel changes) with a dense regular sample (every 2.5s)
 * so no manhwa panel is missed.
 */
async function extractKeyframes(videoPath, { startOffset = 0, searchDuration = 120, targetFrames = 36 } = {}) {
  const tmpDir = path.join(os.tmpdir(), `cutline-vision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const duration = Math.max(10, searchDuration);
  const endOffset = startOffset + duration;

  // 1. Detect abrupt scene / panel cuts via ffmpeg
  let sceneCuts = [];
  try {
    sceneCuts = await ff.detectSceneCuts(videoPath, 0.28, { startOffset, duration });
  } catch {}

  const cutCandidates = sceneCuts
    .filter((t) => t >= startOffset && t <= endOffset)
    .map((t) => Math.round(t * 100) / 100);

  // 2. Add dense grid sampling (every 2.5s) to capture smooth scrolling panels
  const gridCandidates = [];
  const gridStep = Math.max(1.8, Math.min(3.5, duration / Math.max(16, targetFrames)));
  for (let t = startOffset; t <= endOffset; t += gridStep) {
    gridCandidates.push(Math.round(t * 100) / 100);
  }

  // 3. Merge and deduplicate timestamps within 0.8s
  const merged = Array.from(new Set([...cutCandidates, ...gridCandidates])).sort((a, b) => a - b);
  const filteredTs = [];
  for (const t of merged) {
    if (!filteredTs.length || t - filteredTs[filteredTs.length - 1] >= 0.8) {
      filteredTs.push(t);
    }
  }

  // Cap at targetFrames (max 48 to remain super-fast and fit Gemini context)
  const maxFrames = Math.min(48, Math.max(16, targetFrames));
  let finalTs = filteredTs;
  if (finalTs.length > maxFrames) {
    const stride = finalTs.length / maxFrames;
    finalTs = [];
    for (let i = 0; i < maxFrames; i++) {
      finalTs.push(filteredTs[Math.floor(i * stride)]);
    }
  }

  const keyframes = [];
  // Extract in parallel batches of 3 for smooth speed without disk/CPU choke
  const batchSize = 3;
  for (let b = 0; b < finalTs.length; b += batchSize) {
    const batch = finalTs.slice(b, b + batchSize);
    await Promise.all(
      batch.map(async (ts, idx) => {
        const frameIdx = b + idx;
        const outPath = path.join(tmpDir, `kf_${String(frameIdx).padStart(4, '0')}.jpg`);
        await new Promise((resolve) => {
          execFile(
            ff.FFMPEG,
            [
              '-hide_banner',
              '-loglevel', 'error',
              '-threads', '1',
              '-ss', String(ts),
              '-i', videoPath,
              '-an', '-sn',
              '-frames:v', '1',
              '-vf', 'scale=480:-2:flags=fast_bilinear',
              '-q:v', '3',
              '-y',
              outPath
            ],
            { windowsHide: true, timeout: 6000 },
            () => resolve()
          );
        });

        if (fs.existsSync(outPath)) {
          try {
            const buf = fs.readFileSync(outPath);
            keyframes.push({
              id: frameIdx,
              timestamp: ts,
              base64: buf.toString('base64')
            });
            fs.unlinkSync(outPath);
          } catch {}
        }
      })
    );
  }

  try { fs.rmdirSync(tmpDir); } catch {}
  return keyframes.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Helper to discover available generateContent models for the provided Gemini API key.
 */
async function getAvailableGeminiModels(apiKey) {
  if (!apiKey) return [];
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .filter((n) => !/embed|aqa|imagen|veo/i.test(n));
  } catch {
    return [];
  }
}

/**
 * Transcribe Mongolian voiceover narration directly using Gemini Multimodal Audio.
 * Returns exact sentence segments timed to natural breaths and pauses, with visual scene descriptions.
 */
async function transcribeVoiceWithGemini({ voicePath, apiKey, startOffset = 0, duration = null }) {
  if (!apiKey) return null;
  const tmpMp3 = path.join(os.tmpdir(), `cutline-voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
    if (startOffset > 0) ffmpegArgs.push('-ss', String(startOffset));
    const cappedDur = (typeof duration === 'number' && duration > 0) ? Math.min(1800, duration) : 1800;
    ffmpegArgs.push('-t', String(cappedDur));
    ffmpegArgs.push('-i', voicePath, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-y', tmpMp3);

    // 1. Convert audio to lightweight 16kHz mono 48kbps MP3 (under 1.5MB for 3min)
    await new Promise((resolve, reject) => {
      execFile(
        ff.FFMPEG,
        ffmpegArgs,
        { windowsHide: true, timeout: 25000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    if (!fs.existsSync(tmpMp3)) return null;

    const audioBuf = fs.readFileSync(tmpMp3);
    const audioBase64 = audioBuf.toString('base64');
    try { fs.unlinkSync(tmpMp3); } catch {}

    const candidates = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];

    const parts = [
      {
        inlineData: {
          mimeType: 'audio/mp3',
          data: audioBase64
        }
      },
      {
        text: `You are an expert manhwa/anime recap video editor.
Listen carefully to this Mongolian voiceover narration.
1. Transcribe the spoken Mongolian words accurately.
2. Segment the narration into natural sentence-by-sentence story beats matching every natural breath and pause in the speech (typically 2.5s to 4.5s per cut).
3. For each segment, give a short visual description in Mongolian of what manga/comic drawing, character, or event is being described (e.g. "Баатар шоронд сэрэх", "Системийн цонх гарч ирэх", "Мангас дайрах").

Return JSON in this EXACT structure:
{
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 3.4,
      "text": "Баатар шоронд сэрлээ",
      "visualEvent": "Баатар шоронд сэрж буй дүрс"
    }
  ]
}`
      }
    ];

    for (const candidate of candidates) {
      const cleanModel = candidate.replace(/^models\//, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
          signal: AbortSignal.timeout(60000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2
            }
          })
        });

        if (res.status === 404) continue;
        if (!res.ok) continue;

        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        if (!rawText) continue;

        let cleanJson = rawText.trim();
        const jsonMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) cleanJson = jsonMatch[1].trim();

        let parsed;
        try {
          parsed = JSON.parse(cleanJson);
        } catch {
          const fb = cleanJson.indexOf('{');
          const lb = cleanJson.lastIndexOf('}');
          if (fb !== -1 && lb > fb) {
            try { parsed = JSON.parse(cleanJson.slice(fb, lb + 1)); } catch {}
          }
          if (!parsed) {
            const ab = cleanJson.indexOf('[');
            const ae = cleanJson.lastIndexOf(']');
            if (ab !== -1 && ae > ab) {
              try { parsed = JSON.parse(cleanJson.slice(ab, ae + 1)); } catch {}
            }
          }
        }

        const segs = Array.isArray(parsed) ? parsed : (parsed?.segments || parsed?.cuts || []);
        if (Array.isArray(segs) && segs.length) {
          console.log(`[VisionSync] Gemini audio transcribed ${segs.length} Mongolian speech segments successfully.`);
          return segs;
        }
      } catch (err) {
        console.warn(`[VisionSync] Audio transcribe error with ${cleanModel}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[VisionSync] Audio transcribe failed:', err.message);
  } finally {
    try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch {}
  }
  return null;
}

/**
 * Perform Multimodal Vision Matching via Google Gemini API.
 */
async function matchWithGeminiVision({ speechSegments, keyframes, apiKey, model }) {
  if (!apiKey) throw new Error('Gemini API key is required for Vision AI.');
  if (!keyframes.length) throw new Error('No video keyframes extracted.');
  if (!speechSegments.length) throw new Error('No speech segments to match.');

  const parts = [];

  // Add system instruction as part
  parts.push({
    text: `You are an expert anime/manhwa recap video editor.
You are given a sequence of ${keyframes.length} video keyframes (with timestamps in seconds) from a comic recording, and ${speechSegments.length} Mongolian voiceover narration blocks.

Task:
For EVERY narration block, choose the best video timestamp (from the provided keyframes) that best visually represents the described story action, character, or event.

CRITICAL RULES:
1. STRICT STORY CHRONOLOGY: The comic video proceeds sequentially forward in time. Your chosen timestamps MUST advance forward chronologically (sourceTimestamp[k] >= sourceTimestamp[k-1]). NEVER jump backwards!
2. CONTINUOUS FLOW: Each narration block moves to the next scene or panel. Do not jump far ahead or skip major parts of the story.
3. MOTION VS FREEZE:
   - If the keyframe shows active action, fighting, movement, or camera scrolling: set "freeze": false so the moving video plays!
   - If the keyframe shows a still drawing, portrait, dialogue box, or text panel: set "freeze": true so the frame is held still!
   - Alternate dynamically between motion and freeze so the recap is lively, professional, and readable!

Narration blocks:
${JSON.stringify(
  speechSegments.map((s) => ({
    id: s.id,
    time: `${Number(s.start || 0).toFixed(1)}s - ${Number(s.end || 0).toFixed(1)}s`,
    narrationText: s.text || '',
    visualEvent: s.visualEvent || ''
  })),
  null,
  2
)}

Return a JSON object with this EXACT structure:
{
  "matches": [
    { "blockId": 0, "sourceTimestamp": 0.0, "freeze": false, "reason": "Баатар шоронд сэрэх хөдөлгөөн" }
  ]
}`
  });

  // Attach keyframe images with timestamps
  for (const kf of keyframes) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: kf.base64
      }
    });
    parts.push({
      text: `Keyframe #${kf.id} at timestamp: ${kf.timestamp}s`
    });
  }

  // 1. Discover models dynamically from the user's active API key
  const availableModels = await getAvailableGeminiModels(apiKey);

  // 2. Build prioritized candidate list
  const candidates = [];
  if (model && !/2\.5/i.test(model)) candidates.push(model.replace(/^models\//, ''));

  // Prioritize modern fast vision models
  const preferred = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];
  for (const p of preferred) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  // Add all flash models found on user's account (excluding 2.5)
  for (const m of availableModels) {
    if (!/2\.5/i.test(m) && /flash/i.test(m) && !candidates.includes(m)) {
      candidates.push(m);
    }
  }

  // Fallback to latest aliases and remaining models
  const standardFallbacks = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro'
  ];
  for (const fb of standardFallbacks) {
    if (!candidates.includes(fb)) candidates.push(fb);
  }

  // Add any other generateContent model on account
  for (const m of availableModels) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  let lastError = null;

  for (const candidate of candidates) {
    const cleanModel = candidate.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey
        },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        })
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error('Gemini API key хүчингүй байна (Rejected). AI Studio-с түлхүүрээ шалгана уу.');
      }

      if (res.status === 404) {
        // Model not found on this account/region/endpoint - try next candidate
        console.warn(`[VisionSync] Model ${cleanModel} returned 404, trying next available model...`);
        lastError = new Error(`Model ${cleanModel} not found (404)`);
        continue;
      }

      if (res.status === 429 || res.status === 503) {
        throw new Error('Gemini API хүсэлтийн хязгаар (Rate limit) хэтэрсэн байна. Хэсэг хугацааны дараа дахин оролдоно уу.');
      }

      if (!res.ok) {
        let errText = '';
        try { errText = (await res.json())?.error?.message || ''; } catch {}
        throw new Error(`Gemini API алдаа (${res.status}): ${errText}`);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (!rawText) throw new Error('Gemini хоосон хариу буцаалаа.');

      let cleanJson = rawText.trim();
      const jsonMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) cleanJson = jsonMatch[1].trim();

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (parseErr) {
        const firstBrace = cleanJson.indexOf('{');
        const lastBrace = cleanJson.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          try { parsed = JSON.parse(cleanJson.slice(firstBrace, lastBrace + 1)); } catch {}
        }
        if (!parsed) {
          const ab = cleanJson.indexOf('[');
          const ae = cleanJson.lastIndexOf(']');
          if (ab !== -1 && ae > ab) {
            try { parsed = JSON.parse(cleanJson.slice(ab, ae + 1)); } catch {}
          }
        }
      }

      const matches = Array.isArray(parsed) ? parsed : (parsed?.matches || parsed?.cuts || []);
      if (Array.isArray(matches) && matches.length) {
        let lastTs = -1;
        for (let idx = 0; idx < matches.length; idx++) {
          const m = matches[idx];
          let ts = typeof m.sourceTimestamp === 'number' ? m.sourceTimestamp : parseFloat(m.sourceTimestamp);
          if (isNaN(ts) || (lastTs !== -1 && ts < lastTs)) {
            ts = lastTs !== -1 ? lastTs + 1.2 : 0;
          }
          if (lastTs !== -1 && ts > lastTs + 20) {
            ts = lastTs + 3.5;
          }
          m.sourceTimestamp = Math.round(ts * 100) / 100;
          lastTs = m.sourceTimestamp;
          if (m.freeze === undefined) {
            m.freeze = idx % 2 === 1;
          }
        }
        console.log(`[VisionSync] Successfully matched ${matches.length} blocks using Gemini model: ${cleanModel}`);
        return matches;
      }
    } catch (err) {
      if (err.message.includes('хүчингүй') || err.message.includes('хязгаар')) {
        throw err;
      }
      lastError = err;
      console.warn(`[VisionSync] Error with model ${cleanModel}:`, err.message);
    }
  }

  throw lastError || new Error('Боломжит Gemini Vision модель олдсонгүй.');
}

module.exports = { extractKeyframes, matchWithGeminiVision, transcribeVoiceWithGemini };
