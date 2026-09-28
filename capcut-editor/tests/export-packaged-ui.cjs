'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output/export-ui'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
fs.mkdirSync(path.join(profile, 'projects'));
const id = 'proj_export_test', name = 'Export GPU check';
const source = process.argv[2];
const manyCaptions = process.argv.includes('--many-captions');
const captionCount = manyCaptions ? 1746 : process.argv.includes('--captions') ? 40 : 0;
if (!source || !fs.existsSync(source)) throw new Error('Pass a real 1080p source video.');
const project = { format: 'cutline-project', version: 1, name,
 media: [{ id: 'video', path: source, name: 'Source', kind: 'video', duration: 120, width: 1920, height: 1080, fps: 30, hasAudio: false, thumbs: [] }],
 tracks: [{ id: 'v1', name: 'Video 1', kind: 'video', hidden: false, muted: false, locked: false }],
 clips: [{ id: 'clip', kind: 'av', mediaId: 'video', trackId: 'v1', start: 0, inPoint: 30, outPoint: 35 }],
 settings: { width: 1920, height: 1080, fps: 30 } };
if (captionCount) {
 project.tracks.push({ id: 'captions', name: 'Captions', kind: 'overlay', hidden: false, muted: false, locked: false });
 project.clips.push(...Array.from({ length: captionCount }, (_, i) => ({ id: `caption-${i}`, kind: 'text', trackId: 'captions',
  start: i * .1, inPoint: 0, outPoint: .09, x: .5, y: .85,
  style: { text: `Монгол ярианд таарсан хадмал ${i + 1}`, fontSize: 48, color: '#fff', background: '', bold: true, shadow: true } })));
}
fs.writeFileSync(path.join(profile, 'projects', `${id}.cutline`), JSON.stringify(require('../electron/project-store').validateProject(project)));
fs.writeFileSync(path.join(profile, 'projects/projects.json'), JSON.stringify([{ id, name, createdAt: Date.now(), updatedAt: Date.now(), duration: 5, clipCount: 1 }]));
(async () => {
 const app = await _electron.launch({ executablePath: path.join(root, 'release/Cutline/Cutline.exe'), cwd: root,
  env: { ...process.env, CUTLINE_TEST_DIR: profile } });
 try {
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('Renderer error:', e.message); });
  page.on('dialog', async d => { console.log('Dialog:', d.message()); await d.dismiss(); });
  await app.evaluate(({ dialog }, output) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [output] }); }, output);
  if (manyCaptions) await app.evaluate(({ ipcMain }) => {
    globalThis.exportRequests = [];
    ipcMain.removeHandler('export:run');
    ipcMain.handle('export:run', (_event, spec) => {
      globalThis.exportRequests.push({ count: spec.overlays.length, first: spec.overlays[0], last: spec.overlays.at(-1) });
      return { ok: true, path: spec.outPath };
    });
  });
  await page.getByText(name, { exact: true }).first().hover();
  await page.getByTitle(/^(Нээх|Үргэлжлүүлэх)$/).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Export media' });
  await modal.getByText('NVIDIA GPU', { exact: true }).waitFor();
  await modal.getByTitle('Хавтас сонгох', { exact: true }).click();
  await modal.getByPlaceholder('Project name').fill('packaged-export-check');
  await page.screenshot({ path: path.join(output, 'gpu-settings.png') });
  if (manyCaptions) {
    await page.evaluate(() => {
      window.preparationTicks = [];
      window.preparationTimer = setInterval(() => window.preparationTicks.push(performance.now()), 25);
    });
    const started = Date.now();
    await modal.getByRole('button', { name: 'Export', exact: true }).click();
    await modal.getByText(/Хадмал бэлдэж байна.*1746/).waitFor();
    const visibleMs = Date.now() - started;
    assert.ok(visibleMs < 2000, `Preparation display took ${visibleMs}ms`);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await modal.getByRole('button', { name: 'Export', exact: true }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.exportRequests.length), 0, 'Cancelled preparation must never start FFmpeg');
    await page.evaluate(() => { window.preparationTicks = []; });
    await modal.getByRole('button', { name: 'Export', exact: true }).click();
    await modal.getByText(/Хадмал бэлдэж байна.*1746/).waitFor();
    await page.screenshot({ path: path.join(output, 'caption-preparation.png') });
    await modal.getByText('Export completed', { exact: true }).waitFor({ timeout: 180000 });
    const requests = await app.evaluate(() => globalThis.exportRequests.map(r => ({ count: r.count, firstStart: r.first.start, lastEnd: r.last.end })));
    assert.equal(requests.length, 1); assert.equal(requests[0].count, 1746);
    assert.equal(requests[0].firstStart, 0); assert.ok(Math.abs(requests[0].lastEnd - 174.59) < .001);
    const heartbeat = await page.evaluate(() => {
      clearInterval(window.preparationTimer);
      const ticks = window.preparationTicks;
      return { ticks: ticks.length, maxGapMs: Math.max(...ticks.slice(1).map((n, i) => n - ticks[i])) };
    });
    assert.ok(heartbeat.ticks > 5 && heartbeat.maxGapMs < 1000, JSON.stringify(heartbeat));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, captions: 1746, visibleMs, ...heartbeat, cancelledBeforeBackend: true }));
    return;
  }
  await modal.getByRole('button', { name: 'Export', exact: true }).click();
  await modal.getByText('Export completed', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'completed.png') });
  assert.ok(fs.statSync(path.join(output, 'packaged-export-check.mp4')).size > 1000);
  assert.deepEqual(errors, []);
  console.log('PASS: packaged UI detects NVIDIA, exports through the real backend, and displays completion.');
 } catch (e) {
  const page = await app.firstWindow();
  console.log((await page.locator('body').innerText()).slice(0, 3500));
  await page.screenshot({ path: path.join(output, 'failure.png') });
  throw e;
 } finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {});
  await app.close().catch(() => {});
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
