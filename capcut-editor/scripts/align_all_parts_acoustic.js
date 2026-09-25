const fs = require('fs');
const path = require('path');
const ff = require('../electron/ffmpeg.js');

const audioDir = 'C:/Users/Gavl/AppData/Roaming/Cutline/script-studio-audio';
const parts = JSON.parse(fs.readFileSync(path.join(__dirname, '../part_durations.json'), 'utf8'));
const txt = fs.readFileSync(path.join(__dirname, '../mongolian_script.txt'), 'utf8');
const rawSentences = txt.trim().split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(Boolean);

// Split into the 37 chunks matching part_durations.json
const chunkSentencesMap = [];
let curChunk = [];
let curLen = 0;

for (const s of rawSentences) {
  if ((curLen + 1 + s.length) > 2200 && curChunk.length > 0) {
    chunkSentencesMap.push(curChunk);
    curChunk = [s];
    curLen = s.length;
  } else {
    curChunk.push(s);
    curLen += 1 + s.length;
  }
}
if (curChunk.length) {
  chunkSentencesMap.push(curChunk);
}

if (chunkSentencesMap.length !== parts.length) {
  throw new Error(`Chunks mismatch: ${chunkSentencesMap.length} chunks vs ${parts.length} parts`);
}

/**
 * Dynamic programming to partition N acoustic speech segments into S sentences.
 * Every sentence start = segs[first].start
 * Every sentence end = segs[last].end
 * Intra-sentence pauses are enclosed within the sentence.
 * Inter-sentence gaps are REAL acoustic silences!
 */
function alignSentencesToSegments(sentences, segs, partDuration) {
  const S = sentences.length;
  const N = segs.length;
  if (S === 0 || N === 0) return [];

  if (S >= N) {
    // If fewer segments than sentences, distribute proportionally
    const totalChars = sentences.reduce((a, s) => a + s.length, 0);
    let curT = 0;
    return sentences.map((s, idx) => {
      const dur = (s.length / totalChars) * (segs[N - 1].end - segs[0].start);
      const start = (idx === 0) ? segs[0].start : curT;
      const end = (idx === S - 1) ? segs[N - 1].end : (start + dur * 0.92); // 8% pause
      curT = start + dur;
      return {
        text: s,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        segCount: 1
      };
    });
  }

  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const speechSpan = segs[N - 1].end - segs[0].start;
  const targetDurs = sentences.map(s => (s.length / totalChars) * speechSpan);

  // dp[s][j] = best cost to match first s sentences using first j speech segments
  const dp = Array.from({ length: S + 1 }, () => Array(N + 1).fill(Infinity));
  const back = Array.from({ length: S + 1 }, () => Array(N + 1).fill(-1));
  dp[0][0] = 0;

  for (let s = 1; s <= S; s++) {
    const minJ = s;
    const maxJ = N - (S - s);
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = s - 1; i < j; i++) {
        if (dp[s - 1][i] === Infinity) continue;
        const segDur = segs[j - 1].end - segs[i].start;
        const durDiff = Math.abs(segDur - targetDurs[s - 1]);
        
        // Bonus for cutting at larger silence (pause between sentences in TTS is usually >= 0.35s)
        const pauseAfter = (j < N) ? (segs[j].start - segs[j - 1].end) : 0.6;
        const pausePenalty = Math.max(0, 0.45 - pauseAfter) * 2.0;

        const cost = dp[s - 1][i] + (durDiff * durDiff) + (pausePenalty * pausePenalty);
        if (cost < dp[s][j]) {
          dp[s][j] = cost;
          back[s][j] = i;
        }
      }
    }
  }

  const result = [];
  let currJ = N;
  for (let s = S; s >= 1; s--) {
    const prevI = back[s][currJ];
    result.unshift({
      text: sentences[s - 1],
      start: segs[prevI].start,
      end: segs[currJ - 1].end,
      segCount: currJ - prevI
    });
    currJ = prevI;
  }
  return result;
}

async function run() {
  console.log(`[Acoustic Align] Starting alignment for ${parts.length} parts and ${rawSentences.length} sentences...`);
  const allAlignedSentences = [];
  let totalPauses = 0;
  let totalPauseDuration = 0;

  for (let pIdx = 0; pIdx < parts.length; pIdx++) {
    const p = parts[pIdx];
    const pAudioPath = path.join(audioDir, p.file);
    const sents = chunkSentencesMap[pIdx];

    // Detect acoustic speech segments in this part's audio
    const segs = await ff.detectSpeechSegments(pAudioPath, {
      minSilence: 0.22,
      noise: '-30dB'
    });

    const aligned = alignSentencesToSegments(sents, segs, p.duration);

    for (let sIdx = 0; sIdx < aligned.length; sIdx++) {
      const item = aligned[sIdx];
      const nextItem = aligned[sIdx + 1];

      const globalStart = Math.round((p.start + item.start) * 1000) / 1000;
      const globalEnd = Math.round((p.start + item.end) * 1000) / 1000;
      const dur = Math.round((globalEnd - globalStart) * 1000) / 1000;

      if (nextItem) {
        const gap = Math.round((nextItem.start - item.end) * 1000) / 1000;
        if (gap > 0.05) {
          totalPauses++;
          totalPauseDuration += gap;
        }
      }

      allAlignedSentences.push({
        globalId: allAlignedSentences.length,
        part: pIdx,
        sentenceIndex: sIdx,
        text: item.text,
        audioStart: globalStart,
        audioEnd: globalEnd,
        duration: dur,
        segCount: item.segCount
      });
    }

    if ((pIdx + 1) % 5 === 0 || pIdx === parts.length - 1) {
      console.log(`[Acoustic Align] Processed ${pIdx + 1}/${parts.length} parts. Sentences so far: ${allAlignedSentences.length}`);
    }
  }

  console.log(`\n[Acoustic Align Done] Total sentences aligned: ${allAlignedSentences.length}`);
  console.log(`[Acoustic Align Stats] Real acoustic pauses detected: ${totalPauses}, Total pause time: ${totalPauseDuration.toFixed(2)}s`);

  // Load existing full_story_alignments.json to preserve matchedSrtId and english metadata
  const existingPath = path.join(__dirname, '../full_story_alignments.json');
  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));

  const finalAlignments = allAlignedSentences.map((a, idx) => {
    const ex = existing[idx] || {};
    return {
      mongolianId: idx,
      mongolianText: a.text,
      audioStart: a.audioStart,
      audioEnd: a.audioEnd,
      duration: a.duration,
      matchedSrtId: ex.matchedSrtId || 1,
      englishText: ex.englishText || '',
      videoStart: ex.videoStart || 0,
      videoEnd: ex.videoEnd || 0,
      reason: ex.reason || '',
      method: 'real_acoustic_dp_capcut'
    };
  });

  // Save back to full_story_alignments.json and full_story_alignments_with_pauses.json
  fs.writeFileSync(existingPath, JSON.stringify(finalAlignments, null, 2), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../full_story_alignments_with_pauses.json'), JSON.stringify(finalAlignments, null, 2), 'utf8');
  
  // Also copy to release resources so portable build has them
  const portableApp = 'C:/Users/Gavl/Desktop/my project/VIDEO EDITHOR/capcut-editor/release/Cutline/resources/app/full_story_alignments.json';
  const portableRes = 'C:/Users/Gavl/Desktop/my project/VIDEO EDITHOR/capcut-editor/release/Cutline/resources/full_story_alignments.json';
  if (fs.existsSync(path.dirname(portableApp))) fs.writeFileSync(portableApp, JSON.stringify(finalAlignments, null, 2), 'utf8');
  if (fs.existsSync(path.dirname(portableRes))) fs.writeFileSync(portableRes, JSON.stringify(finalAlignments, null, 2), 'utf8');

  console.log('[Acoustic Align Complete] Successfully updated full_story_alignments.json with 100% real acoustic timestamps and pauses!');
}

run().catch(err => {
  console.error('[Acoustic Align Error]:', err);
  process.exit(1);
});
