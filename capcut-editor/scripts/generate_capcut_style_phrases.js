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

function alignSentencesToSegments(sentences, segs) {
  const S = sentences.length;
  const N = segs.length;
  if (S === 0 || N === 0) return [];

  if (S >= N) {
    const totalChars = sentences.reduce((a, s) => a + s.length, 0);
    let curT = segs[0].start;
    return sentences.map((s, idx) => {
      const dur = (s.length / totalChars) * (segs[N - 1].end - segs[0].start);
      const start = (idx === 0) ? segs[0].start : curT;
      const end = (idx === S - 1) ? segs[N - 1].end : (start + dur * 0.90);
      curT = start + dur;
      return {
        text: s,
        start,
        end,
        segs: [segs[Math.min(N - 1, idx)]]
      };
    });
  }

  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const speechSpan = segs[N - 1].end - segs[0].start;
  const targetDurs = sentences.map(s => (s.length / totalChars) * speechSpan);

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
    const sentenceSegs = segs.slice(prevI, currJ);
    result.unshift({
      text: sentences[s - 1],
      start: segs[prevI].start,
      end: segs[currJ - 1].end,
      segs: sentenceSegs
    });
    currJ = prevI;
  }
  return result;
}

function splitSentenceWordsAcrossSegs(text, segs) {
  if (segs.length <= 1) {
    return [{
      text,
      start: segs[0].start,
      end: segs[0].end
    }];
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= segs.length) {
    return segs.map((s, idx) => ({
      text: words[idx] || words[words.length - 1],
      start: s.start,
      end: s.end
    }));
  }

  const totalSegDur = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const result = [];
  let wordIdx = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const segDur = seg.end - seg.start;
    const ratio = Math.max(0.1, segDur / Math.max(0.1, totalSegDur));

    let count = Math.round(words.length * ratio);
    if (i === segs.length - 1) {
      count = words.length - wordIdx;
    } else {
      count = Math.max(1, Math.min(words.length - wordIdx - (segs.length - 1 - i), count));
    }

    const chunk = words.slice(wordIdx, wordIdx + count);
    wordIdx += count;

    result.push({
      text: chunk.join(' '),
      start: seg.start,
      end: seg.end
    });
  }

  return result;
}

async function run() {
  console.log(`[CapCut AutoCaptions] Processing ${parts.length} audio parts...`);
  const allCaptions = [];
  let totalPhrases = 0;
  let totalPauses = 0;

  for (let pIdx = 0; pIdx < parts.length; pIdx++) {
    const p = parts[pIdx];
    const pAudio = path.join(audioDir, p.file);
    const sents = chunkSentencesMap[pIdx];

    const segs = await ff.detectSpeechSegments(pAudio, {
      minSilence: 0.22,
      noise: '-30dB'
    });

    const alignedSentences = alignSentencesToSegments(sents, segs);

    for (let sIdx = 0; sIdx < alignedSentences.length; sIdx++) {
      const a = alignedSentences[sIdx];
      const phrases = splitSentenceWordsAcrossSegs(a.text, a.segs);

      for (let phrIdx = 0; phrIdx < phrases.length; phrIdx++) {
        const ph = phrases[phrIdx];
        const gStart = Math.round((p.start + ph.start) * 1000) / 1000;
        const gEnd = Math.round((p.start + ph.end) * 1000) / 1000;
        const dur = Math.round((gEnd - gStart) * 1000) / 1000;

        allCaptions.push({
          id: allCaptions.length + 1,
          part: pIdx,
          sentenceIndex: sIdx,
          phraseIndex: phrIdx,
          text: ph.text,
          start: gStart,
          end: gEnd,
          duration: dur
        });
        totalPhrases++;
      }
    }
  }

  for (let i = 0; i < allCaptions.length - 1; i++) {
    const gap = allCaptions[i + 1].start - allCaptions[i].end;
    if (gap >= 0.15) totalPauses++;
  }

  console.log(`[CapCut AutoCaptions] Generated ${totalPhrases} dynamic phrase captions!`);
  console.log(`[CapCut AutoCaptions] Real acoustic pauses between captions: ${totalPauses}`);

  const outPath = path.join(__dirname, '../capcut_auto_captions.json');
  fs.writeFileSync(outPath, JSON.stringify(allCaptions, null, 2), 'utf8');
  console.log(`[CapCut AutoCaptions] Saved to ${outPath}`);
}

run().catch(err => {
  console.error('[CapCut AutoCaptions Error]:', err);
  process.exit(1);
});
