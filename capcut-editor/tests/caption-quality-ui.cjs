const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.test-output');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'caption-ui-'));
const id = 'proj_caption_test', name = 'Caption quality test';
const source = path.join(process.env.APPDATA, 'Cutline/script-studio-audio/pool_part_0_1790583229741_l2l4.mp3');
const project = { format: 'cutline-project', version: 1, name,
 media: [{ id: 'audio', path: source, name: 'Sample.mp3', kind: 'audio', duration: 15, width: 0, height: 0, fps: 0, hasAudio: true, thumbs: [] }],
 tracks: [{ id: 'a1', kind: 'audio', name: 'Audio', hidden: false, muted: false, locked: false }, { id: 'o1', kind: 'overlay', name: 'Overlay', hidden: false, muted: false, locked: false }],
 clips: [{ id: 'clip', kind: 'av', mediaId: 'audio', trackId: 'a1', start: 0, inPoint: 0, outPoint: 15 }], settings: { width: 1920, height: 1080, fps: 30 } };
fs.mkdirSync(path.join(profile, 'projects'));
const projectFile = path.join(profile, 'projects', id + '.cutline');
fs.writeFileSync(projectFile, JSON.stringify(project));
fs.writeFileSync(path.join(profile, 'projects/projects.json'), JSON.stringify([{ id, name, createdAt: Date.now(), updatedAt: Date.now(), clipCount: 1, duration: 15 }]));
const script = 'Баатар өглөө эрт гэрээсээ гараад холын аянд мордож замдаа олон шинэ найз нөхөдтэй учирсан бөгөөд тэдэнтэй хамт тосгондоо эргэн ирсэн юм.';
(async () => {
 const app = await _electron.launch({ executablePath: path.join(root, 'release/Cutline/Cutline.exe'), cwd: root, env: { ...process.env, CUTLINE_TEST_DIR: profile } });
 try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('dialog', d => d.dismiss());
  await app.evaluate(({ ipcMain }) => {
   const set = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
   set('whisper:status', () => ({ available: true, models: [{ id: 'base', label: 'Base', installed: true }, { id: 'large-v3-turbo', label: 'Large v3 Turbo', installed: true }] }));
   set('audio:alignScript', async (event, spec) => {
    globalThis.captionSpec = spec;
    event.sender.send('voice-align:progress', { pct: 25, message: 'Тест танилт' });
    if (globalThis.delayCaption) return new Promise(resolve => { globalThis.cancelTestCaption = () => resolve({ ok: false, error: 'Цуцаллаа' }); });
    return { ok: true, segments: [{ id: 0, index: 0, text: spec.scriptText, start: 1, end: 14, duration: 13 }] };
   });
   set('audio:cancelAlign', () => { globalThis.cancelTestCaption(); return true; });
  });
  await page.getByText(name, { exact: true }).first().hover();
  await page.getByTitle('Үргэлжлүүлэх', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#caption-model')?.value === 'large-v3-turbo');
  await page.locator('#caption-script').fill(script);
  await page.getByRole('button', { name: /1 товшилтоор хадмал үүсгэх/ }).click();
  await page.getByRole('button', { name: /Хадмалыг дахин/ }).waitFor();
  const saved = JSON.parse(fs.readFileSync(projectFile));
  const captions = saved.clips.filter(c => c.kind === 'text');
  assert.ok(captions.length >= 2);
  assert.equal(captions.map(c => c.style.text).join(' ').replace(/\s+/g, ' '), script);
  assert.ok(captions.every(c => c.style.text.split('\n').length <= 2));
  const spec = await app.evaluate(() => globalThis.captionSpec);
  assert.equal(spec.whisperModel, 'large-v3-turbo'); assert.equal(spec.mode, 'script_captions');
  await app.evaluate(() => { globalThis.delayCaption = true; });
  await page.getByRole('button', { name: /Хадмалыг дахин/ }).click();
  await page.getByRole('button', { name: /25%/ }).waitFor();
  await page.getByRole('button', { name: 'Хадмал үүсгэхийг цуцлах', exact: true }).click();
  await page.getByRole('button', { name: /Хадмалыг дахин/ }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(projectFile)).clips.length, saved.clips.length);
  await page.screenshot({ path: path.join(output, 'caption-quality-ui.png') });
  console.log('PASS: model selection, exact script preservation, compact captions, progress and cancellation.');
 } finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {});
  await app.close().catch(() => {});
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
