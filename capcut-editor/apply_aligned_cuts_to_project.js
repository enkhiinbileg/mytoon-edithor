const fs = require('fs');
const path = require('path');

const uid = () => Math.random().toString(36).slice(2, 10);

const alignments = JSON.parse(fs.readFileSync('full_story_alignments.json', 'utf8'));
const projectPath = 'C:/Users/Gavl/AppData/Roaming/Cutline/projects/proj_mu7979y5.cutline';
const draftPath = 'C:/Users/Gavl/AppData/Roaming/Cutline/editor-draft.json';

const proj = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

// Find media items
const vMedia = proj.media.find(m => m.id === '3zwas34v') || proj.media.find(m => m.kind === 'video' || m.hasVideo);
const aMedia = proj.media.find(m => m.id === 'rjyjttd6') || proj.media.find(m => m.path && m.path.includes('voice_master_1789977083700_zep1')) || proj.media.find(m => m.kind === 'audio' || (!m.hasVideo && m.hasAudio));

if (!vMedia) throw new Error('Video media not found');
if (!aMedia) throw new Error('Audio media not found');

console.log('Video Media:', vMedia.id, vMedia.name, vMedia.duration + 's');
console.log('Audio Media:', aMedia.id, aMedia.name, aMedia.duration + 's');

// Group contiguous sentences that match the SAME matchedSrtId
const sceneGroups = [];
let curGroup = null;

for (let i = 0; i < alignments.length; i++) {
  const a = alignments[i];
  if (!curGroup || curGroup.matchedSrtId !== a.matchedSrtId) {
    if (curGroup) sceneGroups.push(curGroup);
    curGroup = {
      matchedSrtId: a.matchedSrtId,
      videoStart: a.videoStart,
      videoEnd: a.videoEnd,
      englishText: a.englishText,
      sentences: [a],
      audioStart: a.audioStart,
      audioEnd: a.audioEnd
    };
  } else {
    curGroup.sentences.push(a);
    curGroup.audioEnd = a.audioEnd;
  }
}
if (curGroup) sceneGroups.push(curGroup);

console.log(`Grouped ${alignments.length} sentences into ${sceneGroups.length} distinct scene cuts!`);

const videoClips = [];
const effVoiceDuration = aMedia.duration || 4721.55;

for (let i = 0; i < sceneGroups.length; i++) {
  const g = sceneGroups[i];
  const nextGroup = sceneGroups[i + 1];

  const tStart = (i === 0) ? 0 : g.audioStart;
  const tEnd = nextGroup ? nextGroup.audioStart : effVoiceDuration;
  const cutDur = Math.max(0.3, tEnd - tStart);

  // In video source:
  // Option 1B: Continuous fluid motion starting from videoStart
  let sStart = Math.max(0, Math.min(vMedia.duration - 0.5, g.videoStart));
  let sEnd = Math.min(vMedia.duration, sStart + cutDur);

  // If video ends before cutDur, clamp
  if (sEnd <= sStart) {
    sStart = Math.max(0, vMedia.duration - cutDur - 0.1);
    sEnd = Math.min(vMedia.duration, sStart + cutDur);
  }

  const firstSentence = g.sentences[0];
  const labelText = `[#${g.matchedSrtId}] ${firstSentence.mongolianText.slice(0, 45)}`;

  videoClips.push({
    id: uid(),
    kind: 'av',
    trackId: 'v1',
    start: Math.round(tStart * 1000) / 1000,
    inPoint: Math.round(sStart * 1000) / 1000,
    outPoint: Math.round((sStart + cutDur) * 1000) / 1000,
    mediaId: vMedia.id,
    filterId: 'none',
    effectId: 'none',
    transitionId: 'none',
    label: labelText,
    volume: 0,
    opacity: 1
  });
}

// Ensure audio clip is perfectly on track a1
const audioClips = [
  {
    id: uid(),
    kind: 'av',
    trackId: 'a1',
    start: 0,
    inPoint: 0,
    outPoint: Math.round(effVoiceDuration * 1000) / 1000,
    mediaId: aMedia.id,
    filterId: 'none',
    effectId: 'none',
    transitionId: 'none',
    label: aMedia.name || 'Master Mongolian Voice',
    volume: 1,
    opacity: 1
  }
];

const allClips = [...audioClips, ...videoClips];

// Update project
proj.clips = allClips;
proj.updatedAt = new Date().toISOString();

fs.writeFileSync(projectPath, JSON.stringify(proj, null, 2), 'utf8');
console.log(`Saved ${allClips.length} clips to project: ${projectPath}`);

// Also update editor-draft.json if exists
if (fs.existsSync(draftPath)) {
  try {
    const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    draft.clips = allClips;
    draft.updatedAt = new Date().toISOString();
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2), 'utf8');
    console.log(`Saved to draft: ${draftPath}`);
  } catch (e) {
    console.warn('Could not update draft:', e.message);
  }
}

console.log('\nVerification of generated cuts:');
const checkTimes = [0, 60, 300, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4600];
checkTimes.forEach(t => {
  const c = videoClips.find(clip => clip.start <= t && clip.start + (clip.outPoint - clip.inPoint) > t);
  if (c) {
    const match = alignments.find(a => a.audioStart <= t && a.audioEnd > t) || alignments[0];
    console.log(`Timeline ${t}s: Video inPoint=${c.inPoint.toFixed(1)}s | Label=${c.label} | Story='${match.mongolianText.slice(0, 35)}...'`);
  }
});
