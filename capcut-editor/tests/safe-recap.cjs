'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ff = require('../electron/ffmpeg');
const safeSlicer = require('../electron/safe-recap/safe-slicer');
const safeProc = require('../electron/safe-recap/safe-image-processor');
const safetyAnalyzer = require('../electron/safe-recap/safety-analyzer');
const safeMatcher = require('../electron/safe-recap/safe-matcher');
const sessionStore = require('../electron/safe-recap/safe-session-store');
const safeVoice = require('../electron/safe-recap/safe-voice-pipeline');

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-safe-recap-test-'));
  const fakeApp = { getPath: () => tmpRoot };

  try {
    // 1. Verify Python + ONNX environment
    const env = await safetyAnalyzer.checkEnvironment(fakeApp);
    assert.equal(env.ok, true, `Python/ONNX env check failed: ${env.error}`);
    assert.equal(env.hasImgutils, true);
    assert.equal(env.hasOpencv, true);

    // 2. Generate synthetic test panels + vertical strip with clean white gutter
    const panel1 = path.join(tmpRoot, 'page_1.jpg');
    const strip2 = path.join(tmpRoot, 'page_2.jpg');

    execFileSync(ff.FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=800x1600:duration=1',
      '-frames:v', '1', panel1
    ]);

    // Build a 800x2800 strip: top colored box (1300px) + white gutter (120px) + bottom colored box (1380px)
    execFileSync(ff.FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=800x2800:d=1',
      '-vf', 'drawbox=x=20:y=20:w=760:h=1260:color=steelblue:t=fill,drawbox=x=20:y=1420:w=760:h=1360:color=darkseagreen:t=fill',
      '-frames:v', '1', strip2
    ]);

    // 3. Test safe-slicer
    const slicedRes = await safeSlicer.prepareSafePanels([panel1, strip2], {
      cacheDir: path.join(tmpRoot, 'sliced'),
      sliceMode: 'smart'
    });
    assert.ok(slicedRes.panels.length >= 2, `Expected >=2 panels, got ${slicedRes.panels.length}`);

    // 4. Test FFmpeg cropRect + all 4 censor modes (blur, mosaic, glow, bar)
    const renderDir = path.join(tmpRoot, 'render');
    const sanitized = await safeProc.materializeSanitizedImage({
      imagePath: panel1,
      origW: 800,
      origH: 1600,
      cropRect: { x: 0.1, y: 0.05, w: 0.8, h: 0.45 },
      censorBoxes: [
        { id: 'b1', x: 0.15, y: 0.1, w: 0.25, h: 0.12, mode: 'blur', strength: 20 },
        { id: 'b2', x: 0.5, y: 0.1, w: 0.25, h: 0.12, mode: 'mosaic', strength: 18 },
        { id: 'b3', x: 0.15, y: 0.28, w: 0.25, h: 0.12, mode: 'glow', strength: 18 },
        { id: 'b4', x: 0.5, y: 0.28, w: 0.25, h: 0.12, mode: 'bar' }
      ],
      outDir: renderDir,
      maxWidth: 0
    });
    assert.equal(sanitized.modified, true);
    assert.ok(fs.existsSync(sanitized.path));
    const probed = await ff.probe(sanitized.path);
    assert.equal(probed.width, 640);
    assert.equal(probed.height, 720);

    // 5. Test Python local ONNX batch analysis + cache
    const analyzed = await safetyAnalyzer.analyzePanels({
      app: fakeApp,
      panels: slicedRes.panels,
      cacheDir: path.join(tmpRoot, 'cache'),
      strictness: 'balanced',
      defaultCensorMode: 'blur'
    });
    assert.equal(analyzed.length, slicedRes.panels.length);
    for (const p of analyzed) {
      assert.ok(['safe', 'cropped', 'blurred', 'excluded'].includes(p.safetyStatus));
      assert.ok(p.sanitizedThumbPath && fs.existsSync(p.sanitizedThumbPath), 'Sanitized thumb missing');
    }

    const recheck = await safetyAnalyzer.recheckSingleImage({
      app: fakeApp,
      imagePath: sanitized.path,
      strictness: 'balanced'
    });
    assert.equal(typeof recheck.safe, 'boolean');

    // 6. Test script beat splitting
    const beats = safeMatcher.splitTextToEstimatedBeats(
      'Баатар өрөөнд орж ирлээ. Тэр гэнэт гайхсан харцаар зог тусав! Дараа нь тэд тайван ярилцлаа.'
    );
    assert.equal(beats.length, 3);
    assert.ok(beats[2].end > beats[0].start);

    // 7. Test excluding +18 panel and Gemini SAFETY binary-split fallback
    const testPanels = analyzed.map((p, idx) => ({
      ...p,
      safetyStatus: idx === 1 ? 'excluded' : 'safe'
    }));

    const origFetch = global.fetch;
    try {
      let fetchCalls = 0;
      global.fetch = async (_url, init) => {
        fetchCalls++;
        const payload = JSON.parse(init.body);
        const parts = payload.contents[0].parts;
        const imgParts = parts.filter((x) => x.inlineData);
        // Simulate Gemini blocking the batch whenever panel index 0 of remaining safe panels is in a multi-image batch,
        // or return match for the remaining safe panels once split.
        if (imgParts.length > 1) {
          return new Response(
            JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify([
                    { beatIndex: 0, panelIndex: 0, motion: 'zoom_in', reason: 'Аюулгүй дүрс' },
                    { beatIndex: 1, panelIndex: 0, motion: 'zoom_out', reason: 'Реакц кадр' },
                    { beatIndex: 2, panelIndex: 0, motion: 'pan_down', reason: 'Тайван яриа' }
                  ])
                }]
              }
            }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const aligned = await safeMatcher.alignSafeImagesToBeats({
        beats,
        panels: testPanels,
        apiKey: 'mock-key',
        audioDuration: beats[beats.length - 1].end,
        aspectRatio: '16:9',
        cacheDir: path.join(tmpRoot, 'cache'),
        useAi: true
      });

      assert.ok(fetchCalls >= 2, 'Binary-split safety retry should have fired');
      assert.equal(aligned.plan.length, 3);
      assert.ok(aligned.plan.every((r) => r.safetyStatus !== 'excluded'), 'Excluded panel must never appear in plan');
      assert.equal(aligned.plan[0].start, 0);
    } finally {
      global.fetch = origFetch;
    }

    // 8. Test Whisper draft subtitle fix with clean original Mongolian script
    const fixedRes = await safeVoice.fixSubtitlesWithScript({
      scriptText: '[serious] Баатар өрөөнд орж ирлээ. Тэр гэнэт гайхсан харцаар зог тусав!',
      draftBeats: [
        { id: 'w1', start: 0.0, end: 2.2, text: 'Баатар уруунд орж ирлээ' },
        { id: 'w2', start: 2.3, end: 5.0, text: 'Тэр гэнэт гайхсан харцар зог тусав' }
      ],
      audioDuration: 5.2
    });
    assert.equal(fixedRes.ok, true);
    assert.ok(fixedRes.beats.length >= 2);
    assert.ok(fixedRes.beats.some((b) => b.text.includes('өрөөнд')), 'Expected clean script word "өрөөнд" after script fix');
    assert.ok(!fixedRes.beats.some((b) => b.text.includes('[serious]')), 'Expected audio tags stripped in fixed subtitles');

    // 9. Test session store history summary, load, and delete
    const saved = sessionStore.saveSession(fakeApp, {
      id: 'test_sess',
      name: 'Test Webtoon',
      panels: analyzed,
      subtitles: fixedRes.beats,
      draftSubtitles: beats,
      subtitleMethod: 'whisper(groq-whisper-large-v3)+script-fix',
      inputMode: 'script',
      scriptText: 'Баатар өрөөнд орж ирлээ.'
    });
    assert.equal(saved.ok, true);
    const loaded = sessionStore.loadSession(fakeApp, 'test_sess');
    assert.equal(loaded.name, 'Test Webtoon');
    assert.ok(loaded.completedStages.includes('panels'));
    assert.ok(loaded.completedStages.includes('safety'));
    assert.ok(loaded.completedStages.includes('whisper'));
    assert.ok(loaded.completedStages.includes('fix'));
    const list = sessionStore.listSessions(fakeApp);
    assert.equal(list.length, 1);
    assert.equal(list[0].panelCount, analyzed.length);
    assert.equal(list[0].beatCount, fixedRes.beats.length);
    sessionStore.deleteSession(fakeApp, 'test_sess');
    assert.equal(sessionStore.listSessions(fakeApp).length, 0);

    console.log('ALL SAFE-RECAP TESTS PASSED:', {
      envOk: env.ok,
      slicedCount: slicedRes.panels.length,
      croppedDims: `${probed.width}x${probed.height}`,
      beats: beats.length
    });
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
