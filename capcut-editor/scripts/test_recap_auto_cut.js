const fs = require('fs');
const recapAutoCut = require('../electron/recap-auto-cut.js');

async function test() {
  const proj = JSON.parse(fs.readFileSync('C:/Users/Gavl/AppData/Roaming/Cutline/projects/proj_mu7979y5.cutline', 'utf8'));
  const captions = proj.clips.filter(c => c.trackId === 'ov1');
  console.log('Captions count:', captions.length);

  const res = await recapAutoCut.autoCutByEnglishSrt({
    srtPath: 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt',
    captions,
    projectData: proj
  }, (p) => console.log('Progress:', p));

  console.log('Generated videoClips count:', res.videoClips.length);

  // Find clip with #17
  const c17 = res.videoClips.find(c => c.label.includes('#17]'));
  console.log('Clip #17:', c17);
}

test().catch(console.error);
