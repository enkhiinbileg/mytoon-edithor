const fs = require('fs');
const path = require('path');
const srtParser = require('./electron/srt-parser.js');

const apiKey = fs.readFileSync('gemini_key_plain.tmp', 'utf8').trim();
const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const rawSrt = srtParser.parseSrtFile(srtPath);
const englishSrt = srtParser.reconstructSentences(rawSrt);

const txt = fs.readFileSync('mongolian_script.txt', 'utf8');
const rawSentences = txt.trim().split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(Boolean);

console.log('Total English scenes:', englishSrt.length);
console.log('Total Mongolian sentences:', rawSentences.length);

// Load part durations for exact audio timestamps
const partInfos = JSON.parse(fs.readFileSync('part_durations.json', 'utf8'));

// Split into the 37 chunks
const chunks = [];
let curChunkSentences = [];
let curLen = 0;
const chunkSentencesMap = [];

for (const s of rawSentences) {
  if ((curLen + 1 + s.length) > 2200 && curChunkSentences.length > 0) {
    chunkSentencesMap.push(curChunkSentences);
    chunks.push(curChunkSentences.join(' '));
    curChunkSentences = [s];
    curLen = s.length;
  } else {
    curChunkSentences.push(s);
    curLen += 1 + s.length;
  }
}
if (curChunkSentences.length) {
  chunkSentencesMap.push(curChunkSentences);
  chunks.push(curChunkSentences.join(' '));
}

// Calculate exact audio timestamps
const timedMnSentences = [];
for (let pIdx = 0; pIdx < partInfos.length; pIdx++) {
  const p = partInfos[pIdx];
  const sents = chunkSentencesMap[pIdx] || [];
  const totalChars = sents.reduce((acc, s) => acc + s.length, 0);
  let curT = p.start;
  for (let sIdx = 0; sIdx < sents.length; sIdx++) {
    const s = sents[sIdx];
    const dur = (s.length / Math.max(1, totalChars)) * p.duration;
    timedMnSentences.push({
      id: timedMnSentences.length,
      text: s,
      start: Math.round(curT * 1000) / 1000,
      end: Math.round((curT + dur) * 1000) / 1000,
      duration: Math.round(dur * 1000) / 1000
    });
    curT += dur;
  }
}

console.log('Timed MN sentences:', timedMnSentences.length);

async function alignBatch(mnBatch, srtBatch) {
  const prompt = `You are an expert bilingual manga/anime recap video editor.
You are given:
1. An ordered list of English video subtitle blocks from the original video with video timestamps:
${JSON.stringify(srtBatch.map((s) => ({ id: s.id, time: `${s.start.toFixed(1)}s-${s.end.toFixed(1)}s`, text: s.text })), null, 2)}

2. An ordered list of Mongolian narration sentences:
${JSON.stringify(mnBatch.map((m) => ({ id: m.id, text: m.text })), null, 2)}

Task:
For EACH Mongolian sentence, find the English subtitle block (or range of blocks) that it was translated from or corresponds to in the story.

CRITICAL RULES:
1. STRICT CHRONOLOGY: The story moves forward in time. Matched English subtitle IDs MUST advance forward (matchedSrtStartId >= previous). Never jump backward!
2. If 1 Mongolian sentence combines 2 English subtitle lines, set "matchedSrtStartId" and "matchedSrtEndId".
3. Return JSON in this EXACT structure:
{
  "matches": [
    {
      "mongolianId": 0,
      "matchedSrtStartId": 1,
      "matchedSrtEndId": 1,
      "reason": "Анчин сэрэх үзэгдэл"
    }
  ]
}`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 100)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = JSON.parse(rawText);
  return Array.isArray(parsed) ? parsed : (parsed.matches || parsed.alignments || []);
}

async function main() {
  const BATCH_SIZE = 35;
  const allAlignments = [];
  let currentSrtIdx = 0;

  console.log(`Starting alignment of ${timedMnSentences.length} sentences across 521 SRT scenes...`);
  const t0 = Date.now();

  for (let mIdx = 0; mIdx < timedMnSentences.length; mIdx += BATCH_SIZE) {
    const mnBatch = timedMnSentences.slice(mIdx, mIdx + BATCH_SIZE);
    const srtLookahead = Math.min(englishSrt.length - currentSrtIdx, Math.max(BATCH_SIZE * 2, 50));
    const srtBatch = englishSrt.slice(currentSrtIdx, currentSrtIdx + srtLookahead);

    process.stdout.write(`Batch [${mIdx + 1}-${Math.min(timedMnSentences.length, mIdx + BATCH_SIZE)}/${timedMnSentences.length}] (SRT #${currentSrtIdx})... `);

    let batchMatches = [];
    try {
      batchMatches = await alignBatch(mnBatch, srtBatch);
    } catch (e) {
      console.warn('API error:', e.message);
    }

    if (batchMatches && batchMatches.length) {
      let maxSrtId = currentSrtIdx;

      for (const mn of mnBatch) {
        const match = batchMatches.find((m) => String(m.mongolianId) === String(mn.id));
        const rawStartId = match?.matchedSrtStartId ?? match?.matchedSrtId;
        const srtStartId = (rawStartId !== undefined && rawStartId !== null) ? Number(rawStartId) : null;
        const rawEndId = match?.matchedSrtEndId ?? rawStartId;
        const srtEndId = (rawEndId !== undefined && rawEndId !== null) ? Number(rawEndId) : srtStartId;

        const sStart = (srtStartId !== null ? englishSrt.find((s) => Number(s.id) === srtStartId) : null) || englishSrt[Math.min(englishSrt.length - 1, currentSrtIdx)];
        const sEnd = (srtEndId !== null ? englishSrt.find((s) => Number(s.id) === srtEndId) : null) || sStart;

        const targetIdx = englishSrt.findIndex((s) => s.id === sEnd.id);
        if (targetIdx > maxSrtId) maxSrtId = targetIdx;

        allAlignments.push({
          mongolianId: mn.id,
          mongolianText: mn.text,
          audioStart: mn.start,
          audioEnd: mn.end,
          duration: mn.duration,
          matchedSrtId: sStart.id,
          englishText: sStart.text,
          videoStart: sStart.start,
          videoEnd: sEnd.end,
          reason: match?.reason || '',
          method: 'gemini-3.1-flash-lite'
        });
      }

      currentSrtIdx = Math.min(englishSrt.length - 1, maxSrtId + 1);
      console.log(`OK (advanced to SRT #${currentSrtIdx})`);
    } else {
      // Monotonic proportional fallback for this batch
      console.log('FALLBACK proportional');
      for (let i = 0; i < mnBatch.length; i++) {
        const mn = mnBatch[i];
        const estIdx = Math.min(englishSrt.length - 1, currentSrtIdx + Math.floor((i / mnBatch.length) * Math.min(BATCH_SIZE, srtBatch.length)));
        const srt = englishSrt[estIdx];
        allAlignments.push({
          mongolianId: mn.id,
          mongolianText: mn.text,
          audioStart: mn.start,
          audioEnd: mn.end,
          duration: mn.duration,
          matchedSrtId: srt.id,
          englishText: srt.text,
          videoStart: srt.start,
          videoEnd: srt.end,
          reason: 'fallback',
          method: 'proportional'
        });
      }
      currentSrtIdx = Math.min(englishSrt.length - 1, currentSrtIdx + Math.round(BATCH_SIZE * 0.5));
    }
  }

  console.log(`\nFinished in ${((Date.now() - t0) / 1000).toFixed(1)}s! Total alignments: ${allAlignments.length}`);
  fs.writeFileSync('full_story_alignments.json', JSON.stringify(allAlignments, null, 2));
}

main();
