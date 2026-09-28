const path = require('node:path');
const { scanLatestParts, mergeLatestParts } = require('../electron/voice-recovery');
(async () => {
 const dir = path.join(process.env.APPDATA, 'Cutline', 'script-studio-audio');
 const scan = await scanLatestParts(dir);
 const result = await mergeLatestParts({ dir, outDir: path.resolve('recovered-audio'), token: scan.token, allowGaps: true }, require('../electron/ffmpeg'));
 console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
