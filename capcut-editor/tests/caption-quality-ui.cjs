'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.test-output');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'caption-ui-'));
const id = 'proj_caption_test', name = 'Caption quality test';
// A local fixture and isolated userData keep this test away from real keys and drafts.
const source = path.join(profile, 'source.wav');
const wav = Buffer.alloc(44 + 16000 * 2 * 15);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
fs.writeFileSync(source, wav);
const project = { format: 'cutline-project', version: 1, name,
  media: [{ id: 'audio', path: source, name: 'Sample.wav', kind: 'audio', duration: 15, width: 0, height: 0, fps: 0, hasAudio: true, thumbs: [] }],
  tracks: [{ id: 'a1', kind: 'audio', name: 'Audio', hidden: false, muted: false, locked: false }, { id: 'o1', kind: 'overlay', name: 'Overlay', hidden: false, muted: false, locked: false }, { id: 'v1', kind: 'video', name: 'Muted video', hidden: false, muted: true, locked: true }],
  clips: [{ id: 'clip', kind: 'av', mediaId: 'audio', trackId: 'a1', start: 0, inPoint: 0, outPoint: 13 }, { id: 'long-muted', kind: 'av', mediaId: 'audio', trackId: 'v1', start: 0, inPoint: 0, outPoint: 150 }],
  settings: { width: 1920, height: 1080, fps: 30 }
};
fs.mkdirSync(path.join(profile, 'projects'));
const projectFile = path.join(profile, 'projects', id + '.cutline');
fs.writeFileSync(projectFile, JSON.stringify(project));
fs.writeFileSync(path.join(profile, 'projects/projects.json'), JSON.stringify([{ id, name, createdAt: Date.now(), updatedAt: Date.now(), clipCount: 1, duration: 13 }]));
const script = 'Баатар өглөө эрт гэрээсээ гараад холын аянд мордож замдаа олон шинэ найз нөхөдтэй учирсан бөгөөд тэдэнтэй хамт тосгондоо эргэн ирсэн юм.';
const savedCaptions = () => JSON.parse(fs.readFileSync(projectFile)).clips.filter(c => c.kind === 'text');
async function waitSaved(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check(savedCaptions())) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Expected caption autosave did not arrive');
}
(async () => {
  const app = await _electron.launch({
    executablePath: path.join(root, process.env.CUTLINE_TEST_PACKAGED ? 'release/Cutline/Cutline.exe' : 'node_modules/electron/dist/electron.exe'),
    args: process.env.CUTLINE_TEST_PACKAGED ? [] : [root], cwd: root,
    env: { ...process.env, CUTLINE_TEST_DIR: profile }
  });
  try {
    const page = await app.firstWindow(), alerts = [], errors = [];
    page.setDefaultTimeout(20000);
    page.on('dialog', d => { alerts.push(d.message()); void d.dismiss(); });
    page.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ ipcMain }) => {
      const set = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
      globalThis.captionFixture = { scenario: 'success', renders: [], alignments: [], cancellations: 0 };
      set('whisper:status', () => ({ available: true, models: [{ id: 'large-v3-turbo', label: 'Large v3 Turbo', installed: true }] }));
      set('whisper:getGroqKeys', () => []);
      set('audio:renderTimelineSpeech', async (_event, spec) => {
        const fixture = globalThis.captionFixture;
        fixture.renders.push(spec);
        if (fixture.scenario === 'render-failure') return { ok: false, error: 'Fixture timeline rendering failed' };
        const result = { ok: true, audioPath: 'fixture-timeline.wav', duration: spec.duration };
        if (fixture.scenario === 'delay-render') return new Promise(resolve => { fixture.resolve = () => resolve(result); });
        return result;
      });
      set('audio:alignScript', async (event, spec) => {
        const fixture = globalThis.captionFixture;
        fixture.alignments.push(spec);
        if (fixture.scenario === 'quality-failure') return { ok: false, error: '22:30–22:34 хэсгийн яриа найдвартай танигдсангүй.' };
        event.sender.send('voice-align:progress', { pct: 25, message: 'Тест танилт' });
        const result = { ok: true, segments: [{ id: 0, index: 0, text: spec.scriptText, start: 1, end: 12, duration: 11 }] };
        if (fixture.scenario === 'delay-align') return new Promise(resolve => { fixture.resolve = () => resolve(result); });
        return result;
      });
      // Deliberately let the delayed operation finish successfully after cancellation.
      set('audio:cancelAlign', () => { globalThis.captionFixture.cancellations++; return true; });
    });
    await page.reload();
    await page.getByText(name, { exact: true }).first().hover();
    await page.getByTitle('Үргэлжлүүлэх', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: /Auto captions/ }).click();
    await page.waitForFunction(() => document.querySelector('#caption-model')?.value === 'large-v3-turbo');
    await page.locator('#caption-script').fill(script);
    const generate = () => page.getByRole('button', { name: /1 товшилтоор.*хадмал үүсгэх|Хадмалыг дахин/ });
    const idle = () => page.getByRole('button', { name: /Хадмалыг дахин/ }).waitFor();
    const scenario = value => app.evaluate((_electron, value) => { globalThis.captionFixture.scenario = value; globalThis.captionFixture.resolve = null; }, value);
    const settleRenderer = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const resolveJob = async () => {
      assert.equal(await app.evaluate(() => typeof globalThis.captionFixture.resolve), 'function', 'expected delayed operation is pending');
      await app.evaluate(() => globalThis.captionFixture.resolve());
      await settleRenderer();
    };

    await generate().click(); await idle();
    await waitSaved(captions => captions.length >= 2);
    const compact = savedCaptions();
    assert.equal(compact.map(c => c.style.text).join(' ').replace(/\s+/g, ' '), script);
    assert.ok(compact.every(c => c.style.text.split('\n').length <= 2));
    assert.equal(compact[0].start, 1);
    assert.ok(Math.abs(compact.at(-1).start + compact.at(-1).outPoint - 12) < 0.002);
    const firstRequest = await app.evaluate(() => ({ render: globalThis.captionFixture.renders[0], align: globalThis.captionFixture.alignments[0] }));
    assert.equal(firstRequest.render.audio[0].outPoint, 13, 'single trimmed source is rendered');
    assert.equal(firstRequest.render.duration, 13);
    assert.equal(firstRequest.align.audioPath, 'fixture-timeline.wav');
    assert.equal(firstRequest.align.whisperModel, 'large-v3-turbo');
    assert.equal(firstRequest.align.mode, 'script_captions');

    await page.getByRole('checkbox', { name: 'Богино хадмал · 2 мөр', exact: true }).uncheck();
    await generate().click(); await idle();
    await waitSaved(captions => captions.length === 1 && captions[0].style.text === script);
    const preserved = savedCaptions();
    await scenario('quality-failure');
    await generate().click(); await idle();
    assert.match(alerts.at(-1), /22:30–22:34.*найдвартай танигдсангүй/);
    assert.deepEqual(savedCaptions(), preserved, 'failed quality validation must preserve previous captions');
    const priorAlignmentCount = await app.evaluate(() => globalThis.captionFixture.alignments.length);
    await scenario('render-failure');
    await generate().click(); await idle();
    assert.match(alerts.at(-1), /Fixture timeline rendering failed/);
    assert.equal(await app.evaluate(() => globalThis.captionFixture.alignments.length), priorAlignmentCount, 'failed render never transcribes the full source');
    assert.deepEqual(savedCaptions(), preserved);

    await scenario('delay-align');
    await generate().click();
    await page.getByRole('button', { name: /25%/ }).waitFor();
    await page.getByLabel('Project name').fill('Changed while captions were running');
    await page.getByLabel('Project name').press('Tab');
    await resolveJob(); await idle();
    assert.match(alerts.at(-1), /төсөл өөрчлөгдсөн/);
    assert.deepEqual(savedCaptions(), preserved, 'stale successful recognition preserves captions');

    await generate().click();
    await page.getByRole('button', { name: /25%/ }).waitFor();
    await page.getByRole('button', { name: /Хадмал үүсгэхийг цуцлах/ }).click();
    await idle(); await resolveJob();
    assert.deepEqual(savedCaptions(), preserved, 'success arriving after cancel cannot replace captions');
    assert.equal(await app.evaluate(() => globalThis.captionFixture.cancellations), 1);

    await scenario('delay-render');
    const beforeRenderCancel = await app.evaluate(() => globalThis.captionFixture.alignments.length);
    await generate().click();
    await page.getByRole('button', { name: /Хадмал үүсгэхийг цуцлах/ }).click();
    await idle(); await resolveJob();
    assert.equal(await app.evaluate(() => globalThis.captionFixture.alignments.length), beforeRenderCancel, 'cancelling preparation does not start recognition');
    assert.deepEqual(savedCaptions(), preserved);

    const beforeMuted = await app.evaluate(() => globalThis.captionFixture.renders.length);
    await page.locator('.track-head').filter({ hasText: 'Audio' }).getByTitle('Дууг хаах', { exact: true }).click();
    await generate().click(); await idle();
    assert.match(alerts.at(-1), /дуу нь нээлттэй/);
    assert.equal(await app.evaluate(() => globalThis.captionFixture.renders.length), beforeMuted, 'muted source does not fall back to library audio');
    assert.deepEqual(savedCaptions(), preserved);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'caption-quality-ui.png') });
    console.log('PASS: exact compact/noncompact captions, timeline rendering, render failure, stale project, cancellation and muted source.');
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
