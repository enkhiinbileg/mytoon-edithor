'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ff = require('../electron/ffmpeg');
const srtParser = require('../electron/srt-parser');
const realRecapAutoCut = require('../electron/recap-auto-cut');
const projectStore = require('../electron/project-store');
const pipeline = require('../electron/auto-recap-pipeline');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockApp(userDataDir) {
  return {
    getPath(name) {
      if (name === 'userData') return userDataDir;
      if (name === 'downloads') return path.join(userDataDir, 'Downloads');
      if (name === 'videos') return path.join(userDataDir, 'Videos');
      return userDataDir;
    }
  };
}

async function makeSyntheticVideo(outPath, durationSec = 6) {
  await ff.run(ff.FFMPEG, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc2=size=640x360:rate=30:duration=${durationSec}`,
    '-f', 'lavfi',
    '-i', `sine=frequency=220:sample_rate=48000:duration=${durationSec}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    outPath
  ]);
}

async function makeSyntheticAudio(outPath, durationSec = 4.5) {
  await ff.run(ff.FFMPEG, [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    outPath
  ]);
}

function createFakeSettings(overrides = {}) {
  return {
    getKeyPoolDecrypted: () => overrides.poolKeys ?? [
      { id: 'k1', label: 'Key1', apiKey: 'el_test_secret_123456', enabled: true, quota: { remaining: 25000 } }
    ],
    secret: (name) => {
      if (name === 'geminiApiKey') return overrides.geminiKey ?? 'gem_test_secret_123456';
      if (name === 'elevenLabsApiKey') return overrides.elevenKey ?? 'el_test_secret_123456';
      if (name === 'groqApiKey') return overrides.groqKey ?? 'gsk_test_secret_123456';
      return '';
    }
  };
}

test('Shared core (script-align-core.mjs) aligns, lays out 2-line captions, strips tags, and sanitizes overlaps', async () => {
  const core = await import('../electron/script-align-core.mjs');

  const rawScript = '[whispers] Тэр шөнө баатар сүүдэрт нуугдаж хүлээв. [excited] Гэтэл гэнэт тэнгэр цахилгаан цахиж хаалга нээгдлээ!';
  const { text: cleanScript, removedCount } = core.clearTagsFromScript(rawScript);
  assert.equal(removedCount, 2);
  assert.equal(cleanScript.includes('[whispers]'), false);

  const tagged = core.autoTagMongolianScript('Тэр чангаар орилон тулалдлаа!', { intensity: 'dramatic' });
  assert.equal(tagged.tagsAdded >= 1, true);

  // Layout compact 2-line captions
  const longSeg = [{
    text: 'Тэр шөнө баатар сүүдэрт нуугдаж хүлээв гэтэл гэнэт тэнгэр цахилгаан цахиж хаалга нээгдлээ гэж бүгд гайхав',
    start: 0,
    duration: 4.0
  }];
  const laidOut = core.layoutCaptions(longSeg);
  assert.equal(laidOut.length >= 2, true);
  assert.equal(laidOut.some((s) => s.text.includes('\n')), true);

  // Align corrupted Whisper words back to clean script + reflow
  const noisyClips = [
    { id: 'c1', kind: 'text', trackId: 'o1', start: 0, inPoint: 0, outPoint: 2.0, style: { text: 'тэр шоно баатар сүүдэрт нугдаж хулэв гэтэл' } },
    { id: 'c2', kind: 'text', trackId: 'o1', start: 2.0, inPoint: 0, outPoint: 2.5, style: { text: 'гэнэт тэнгэр цахилган цахиж хаалга нээгдлэ' } }
  ];
  const aligned = core.alignScriptToClips(cleanScript, noisyClips, { mode: 'full' });
  const reflowed = core.reflowSentenceBoundaries(aligned.updatedClips);
  const sanitized = pipeline.sanitizePipelineCaptions(reflowed.updatedClips, 4.5);

  assert.equal(sanitized.length, 2);
  assert.ok(sanitized[0].style.text.includes('Тэр шөнө баатар'));
  assert.ok(sanitized[1].style.text.endsWith('нээгдлээ!'));

  // Monotonic non-overlapping guarantee even with messy raw timings
  const messy = [
    { id: 'm1', start: 1.0, inPoint: 0, outPoint: 1.5, style: { text: 'Аан нэг' } },
    { id: 'm2', start: 0.5, inPoint: 0, outPoint: 0.01, style: { text: '   ' } },
    { id: 'm3', start: 1.8, inPoint: 0, outPoint: 5.0, style: { text: 'Хоёрдугаар мөр' } }
  ];
  const cleanTimings = pipeline.sanitizePipelineCaptions(messy, 4.0);
  assert.equal(cleanTimings.length, 2);
  assert.ok(cleanTimings[1].start > cleanTimings[0].start);
  assert.ok(cleanTimings[1].start >= cleanTimings[0].start + cleanTimings[0].outPoint - cleanTimings[0].inPoint - 1e-6);
  assert.ok(cleanTimings[1].start + cleanTimings[1].outPoint <= 4.0 + 1e-6);
});

test('preflightAutoPipeline detects filename SRT offset and blocks invalid inputs before paid calls', async () => {
  const dir = makeTempDir('cutline-pf-');
  try {
    const videoPath = path.join(dir, 'manga_ep1_[00-00-02_cut].mp4');
    const srtPath = path.join(dir, 'manga.srt');
    await makeSyntheticVideo(videoPath, 5);
    fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,000\nIntro line\n\n2\n00:00:02,000 --> 00:00:05,000\nHero enters\n', 'utf8');

    assert.equal(pipeline.detectSrtSliceFromVideoName(videoPath), '00:00:02');

    // Missing script should fail
    const badScript = await pipeline.preflightAutoPipeline(
      { scriptText: '   ', videoPath, srtPath, exportDir: dir },
      {
        app: makeMockApp(dir),
        settings: createFakeSettings(),
        whisper: { status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', label: 'Groq v3', installed: true }] }) }
      }
    );
    assert.equal(badScript.ok, false);

    // Missing Gemini key should fail (temporarily isolate from env GEMINI_API_KEY)
    const prevEnvGemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    let noGemini;
    try {
      noGemini = await pipeline.preflightAutoPipeline(
        { scriptText: 'Баатар ирлээ.', videoPath, srtPath, exportDir: dir },
        {
          app: makeMockApp(dir),
          settings: createFakeSettings({ geminiKey: '' }),
          whisper: { status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', label: 'Groq v3', installed: true }] }) }
        }
      );
    } finally {
      if (prevEnvGemini !== undefined) process.env.GEMINI_API_KEY = prevEnvGemini;
    }
    assert.equal(noGemini.ok, false);

    // Valid preflight passes
    const good = await pipeline.preflightAutoPipeline(
      { scriptText: 'Баатар орж ирлээ.', videoPath, srtPath, exportDir: dir },
      {
        app: makeMockApp(dir),
        settings: createFakeSettings(),
        whisper: { status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', label: 'Groq v3', installed: true }] }) }
      }
    );
    assert.equal(good.ok, true);
    assert.equal(good.estimate.autoDetectedSrtStart, '00:00:02');
    assert.equal(good.estimate.slicedSrtEntries, 1);
    assert.equal(good.estimate.targetWidth, 1920);
    assert.equal(good.estimate.targetHeight, 1080);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('End-to-end 5-stage pipeline runs real FFmpeg cut/freeze/export, repairs subtitles with script, removes subtitles, and saves clean project', async () => {
  const dir = makeTempDir('cutline-e2e-');
  const userData = path.join(dir, 'userdata');
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    const videoPath = path.join(dir, 'source_episode.mp4');
    const preAudio = path.join(dir, 'voice_source.mp3');
    const srtPath = path.join(dir, 'source_episode.srt');

    await makeSyntheticVideo(videoPath, 6.0);
    await makeSyntheticAudio(preAudio, 4.2);

    fs.writeFileSync(srtPath, [
      '1\n00:00:00,200 --> 00:00:02,000\nThe hero enters the dark castle.\n',
      '2\n00:00:02,200 --> 00:00:05,500\nSuddenly the dragon opens its eyes.\n'
    ].join('\n'), 'utf8');

    const observed = {
      ttsScript: '',
      whisperModel: '',
      whisperScriptText: null,
      progressSteps: []
    };

    const scriptText = '[whispers] Баатар харанхуй шилтгээн рүү сэм орлоо. Гэнэт луу нүдээ нээн гал тургив!';

    const deps = {
      settings: createFakeSettings(),
      whisper: {
        status: () => ({
          available: true,
          models: [{ id: 'groq-whisper-large-v3', label: 'Groq Cloud Large v3', installed: true }]
        })
      },
      scriptStudio: {
        buildScriptRecap: async (ttsSpec, prog) => {
          observed.ttsScript = ttsSpec.scriptText;
          fs.mkdirSync(ttsSpec.outDir, { recursive: true });
          const voiceOut = path.join(ttsSpec.outDir, 'master_test.mp3');
          fs.copyFileSync(preAudio, voiceOut);
          prog?.({ partIndex: 1, totalParts: 1, message: 'Mock ElevenLabs OK' });
          return { ok: true, audioPath: voiceOut, voiceDuration: 4.2, sentences: [], cuts: [] };
        }
      },
      audioScriptAlign: {
        alignAudioWithScript: async (alignSpec, prog) => {
          observed.whisperModel = alignSpec.whisperModel;
          observed.whisperScriptText = alignSpec.scriptText;
          prog?.({ pct: 100, message: 'Mock Groq Whisper OK' });
          // Return long segment so compactCaptions splits into multiple 2-line captions, with intentional typos for Stage 3 to fix
          return {
            ok: true,
            audioDuration: 4.2,
            method: 'capcut_auto_captions',
            segments: [
              {
                id: 1,
                text: 'Баатар харанху шилтгэн ру сэм орло Гэнэт лу нудээ нэж гал тургив гэж харагдана гэхдээ үргэлжлэл бий',
                start: 0.0,
                end: 4.1,
                duration: 4.1
              }
            ]
          };
        }
      },
      recapAutoCut: {
        autoCutByEnglishSrt: (cutSpec, prog) =>
          realRecapAutoCut.autoCutByEnglishSrt(cutSpec, prog, {
            resolveAlignments: async ({ captions, englishSrt }) => ({
              method: 'test-ai',
              warnings: [],
              alignments: captions.map((c, idx) => {
                const eng = englishSrt[Math.min(idx, englishSrt.length - 1)];
                return {
                  captionId: c.id,
                  audioStart: c.start,
                  audioEnd: c.start + (c.outPoint - c.inPoint),
                  videoStart: eng.start,
                  videoEnd: Math.min(eng.end, 5.8),
                  matchedSrtId: eng.id,
                  englishText: eng.text,
                  mode: 'match'
                };
              })
            })
          })
      }
    };

    const res = await pipeline.runAutoPipeline({
      scriptText,
      videoPath,
      srtPath,
      outputName: 'ep1_final_auto',
      exportDir,
      whisperModel: 'groq-whisper-large-v3',
      compactCaptions: true,
      saveProjectToLibrary: true,
      exportOptions: {
        resolution: '480P',
        fps: 24,
        codec: 'h264',
        quality: 'draft',
        format: 'mp4',
        audioBitrate: '128k'
      }
    }, {
      app: makeMockApp(userData),
      deps,
      onProgress: (p) => observed.progressSteps.push(p.stepKey)
    });

    assert.equal(res.ok, true, res.error || 'Pipeline failed');
    // Stage 1 received original script with [whispers]
    assert.ok(observed.ttsScript.includes('[whispers]'));
    // Stage 2 explicitly used groq-whisper-large-v3 with pure voice (scriptText === '')
    assert.equal(observed.whisperModel, 'groq-whisper-large-v3');
    assert.equal(observed.whisperScriptText, '');
    // Stage 3 repaired captions cleanly without [whispers] tag and preserved Mongolian words on cut metadata
    const cutText = res.cleanProject.clips
      .filter((c) => c.trackId === 'v1')
      .map((c) => c.mongolianText || '')
      .join(' ');
    assert.equal(cutText.includes('[whispers]'), false);
    assert.ok(cutText.includes('шилтгээн'));
    // Stage 5 deleted all temporary captions
    assert.equal(res.report.finalTextClipCount, 0);
    assert.equal(res.cleanProject.clips.some((c) => c.kind === 'text'), false);
    // Clean library project exists and passes strict validation
    assert.ok(res.savedProjectId);
    assert.ok(fs.existsSync(res.savedProjectPath));
    const savedDoc = JSON.parse(fs.readFileSync(res.savedProjectPath, 'utf8'));
    const validated = projectStore.validateProject(savedDoc);
    assert.equal(validated.clips.some((c) => c.kind === 'text'), false);
    // Final MP4 file exists and is valid video + audio
    assert.ok(fs.existsSync(res.outPath));
    assert.ok(fs.statSync(res.outPath).size > 2000);
    const outProbe = await ff.probe(res.outPath);
    assert.equal(outProbe.hasVideo, true);
    assert.equal(outProbe.hasAudio, true);
    assert.ok(outProbe.duration > 3.5 && outProbe.duration < 5.0);
    // History tracks completion
    const jobs = pipeline.listAutoPipelineJobs(makeMockApp(userData));
    assert.equal(jobs[0].status, 'completed');
    assert.deepEqual(jobs[0].completedStages, ['voice', 'whisper', 'fix', 'autocut', 'export']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Checkpoint resume skips already-finished Stage 1/2/3 without re-calling ElevenLabs or Whisper', async () => {
  const dir = makeTempDir('cutline-resume-');
  const userData = path.join(dir, 'userdata');
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    const videoPath = path.join(dir, 'ep2.mp4');
    const preAudio = path.join(dir, 'voice2.mp3');
    const srtPath = path.join(dir, 'ep2.srt');
    await makeSyntheticVideo(videoPath, 4.0);
    await makeSyntheticAudio(preAudio, 2.5);
    fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:03,500\nScene one action.\n', 'utf8');

    let ttsCalls = 0;
    let whisperCalls = 0;
    let shouldFailCut = true;

    const deps = {
      settings: createFakeSettings(),
      whisper: {
        status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', installed: true }] })
      },
      scriptStudio: {
        buildScriptRecap: async (ttsSpec) => {
          ttsCalls++;
          fs.mkdirSync(ttsSpec.outDir, { recursive: true });
          const voiceOut = path.join(ttsSpec.outDir, 'voice2.mp3');
          fs.copyFileSync(preAudio, voiceOut);
          return { ok: true, audioPath: voiceOut, voiceDuration: 2.5 };
        }
      },
      audioScriptAlign: {
        alignAudioWithScript: async () => {
          whisperCalls++;
          return {
            ok: true,
            audioDuration: 2.5,
            segments: [{ id: 1, text: 'Нэгдугэр үзэгдэл эхэллээ.', start: 0, end: 2.4, duration: 2.4 }]
          };
        }
      },
      recapAutoCut: {
        autoCutByEnglishSrt: async (cutSpec, prog) => {
          if (shouldFailCut) {
            throw new Error('Simulated network timeout with key gem_test_secret_123456');
          }
          return realRecapAutoCut.autoCutByEnglishSrt(cutSpec, prog, {
            resolveAlignments: async ({ captions, englishSrt }) => ({
              method: 'test-resume',
              alignments: captions.map((c) => ({
                captionId: c.id,
                audioStart: c.start,
                audioEnd: c.start + (c.outPoint - c.inPoint),
                videoStart: englishSrt[0].start,
                videoEnd: 3.0,
                matchedSrtId: englishSrt[0].id,
                englishText: englishSrt[0].text,
                mode: 'match'
              }))
            })
          });
        }
      }
    };

    const appMock = makeMockApp(userData);
    const failed = await pipeline.runAutoPipeline({
      scriptText: 'Нэгдүгээр үзэгдэл эхэллээ.',
      videoPath,
      srtPath,
      exportDir,
      outputName: 'ep2_out',
      saveProjectToLibrary: false,
      exportOptions: { resolution: '480P', fps: 24, codec: 'h264', quality: 'draft' }
    }, { app: appMock, deps });

    assert.equal(failed.ok, false);
    assert.deepEqual(failed.completedStages, ['voice', 'whisper', 'fix']);
    // Ensure secret was redacted from error & manifest never stored raw API keys
    assert.equal(failed.error.includes('gem_test_secret_123456'), false);
    const rawManifest = fs.readFileSync(path.join(userData, 'auto-pipeline-jobs', failed.jobId, 'manifest.json'), 'utf8');
    assert.equal(rawManifest.includes('gem_test_secret_123456'), false);

    // Resume after fixing Stage 4
    shouldFailCut = false;
    const resumed = await pipeline.resumeAutoPipeline(failed.jobId, {}, { app: appMock, deps });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(ttsCalls, 1, 'Stage 1 TTS must not re-run on resume');
    assert.equal(whisperCalls, 1, 'Stage 2 Whisper must not re-run on resume');
    assert.ok(fs.existsSync(resumed.outPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cancellation via AbortController stops cleanly without running downstream stages', async () => {
  const dir = makeTempDir('cutline-cancel-');
  const userData = path.join(dir, 'userdata');
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    const videoPath = path.join(dir, 'ep3.mp4');
    const srtPath = path.join(dir, 'ep3.srt');
    await makeSyntheticVideo(videoPath, 3.0);
    fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,500\nQuick scene.\n', 'utf8');

    const controller = new AbortController();
    let whisperCalled = false;

    const res = await pipeline.runAutoPipeline({
      scriptText: 'Зогсоох шалгалт.',
      videoPath,
      srtPath,
      exportDir
    }, {
      app: makeMockApp(userData),
      signal: controller.signal,
      deps: {
        settings: createFakeSettings(),
        whisper: { status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', installed: true }] }) },
        scriptStudio: {
          buildScriptRecap: async () => {
            controller.abort();
            throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          }
        },
        audioScriptAlign: {
          alignAudioWithScript: async () => {
            whisperCalled = true;
            return { ok: true, segments: [] };
          }
        }
      }
    });

    assert.equal(res.ok, false);
    assert.equal(res.canceled, true);
    assert.equal(whisperCalled, false);
    const jobs = pipeline.listAutoPipelineJobs(makeMockApp(userData));
    assert.equal(jobs[0].status, 'canceled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCleanProjectAndExportSpec forwards custom Kbps bitrate and CBR/VBR mode cleanly', () => {
  const videoMediaItem = { id: 'mv', path: '/tmp/v.mp4', name: 'v.mp4', kind: 'video', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: false, thumbs: [] };
  const voiceMediaItem = { id: 'ma', path: '/tmp/a.mp3', name: 'a.mp3', kind: 'audio', duration: 10, width: 0, height: 0, fps: 0, hasAudio: true, thumbs: [] };
  const voiceClip = { id: 'ca', kind: 'av', mediaId: 'ma', trackId: 'a1', start: 0, inPoint: 0, outPoint: 10, volume: 1 };
  const cleanVideoClips = [{ id: 'cv', kind: 'av', mediaId: 'mv', trackId: 'v1', start: 0, inPoint: 0, outPoint: 10, volume: 0 }];

  const vbr = pipeline.buildCleanProjectAndExportSpec({
    cleanVideoClips,
    newMedia: [],
    videoMediaItem,
    voiceMediaItem,
    voiceClip,
    projectName: 'test_custom',
    outPath: '/tmp/out.mp4',
    exportOptions: {
      codec: 'hevc',
      bitrateOption: 'custom',
      customBitrate: 1000,
      bitrateType: 'vbr',
      audioBitrate: '192k'
    },
    width: 1920,
    height: 1080,
    fps: 30,
    voiceDuration: 10
  });

  assert.equal(vbr.exportSpec.bitrateMode, 'vbr');
  assert.equal(vbr.exportSpec.customBitrate, 1000);
  assert.equal(vbr.exportSpec.overlays.length, 0);

  const cbr = pipeline.buildCleanProjectAndExportSpec({
    cleanVideoClips,
    newMedia: [],
    videoMediaItem,
    voiceMediaItem,
    voiceClip,
    projectName: 'test_cbr',
    outPath: '/tmp/out2.mp4',
    exportOptions: {
      codec: 'h264',
      bitrateOption: 'custom',
      customBitrate: 2500,
      bitrateType: 'cbr'
    },
    width: 1920,
    height: 1080,
    fps: 30,
    voiceDuration: 10
  });

  assert.equal(cbr.exportSpec.bitrateMode, 'cbr');
  assert.equal(cbr.exportSpec.customBitrate, 2500);
});

test('elevenlabs-pool dispatchPoolTTS preserves real fatal/quota error instead of masking as user cancel', async () => {
  const Module = require('node:module');
  const dir = makeTempDir('cutline-pool-err-');
  const origLoad = Module._load;
  const fakeSettings = {
    getKeyPoolDecrypted: () => [
      { id: 'k1', label: 'Key1', apiKey: 'el_key_1', enabled: true, quota: { remaining: 50 }, status: 'ready' }
    ],
    updateKeyPoolQuota: () => {},
    secret: () => ''
  };
  const fakeTts = {
    speakWithTimestamps: async () => {
      const err = new Error('quota_exceeded: Not enough credits');
      err.status = 401;
      err.code = 'quota_exceeded';
      throw err;
    }
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: makeMockApp(dir), safeStorage: { isEncryptionAvailable: () => false } };
    }
    if (request === './settings' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeSettings;
    }
    if (request === './tts' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeTts;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const poolPath = require.resolve('../electron/elevenlabs-pool');
    delete require.cache[poolPath];
    const pool = require('../electron/elevenlabs-pool');

    // Case 1: Fatal quota error with NO user abort -> must NOT report Хэрэглэгч зогсоолоо
    await assert.rejects(
      () => pool.dispatchPoolTTS({
        chunks: ['Сайн байна уу, энэ бол туршилтын өгүүлбэр юм.'],
        outDir: dir,
        resume: false
      }),
      (err) => {
        assert.notEqual(err.name, 'AbortError');
        assert.equal(err.message.includes('Хэрэглэгч зогсоолоо'), false);
        assert.ok(err.message.includes('кредит') || err.message.includes('quota'));
        return true;
      }
    );

    // Case 2: External AbortController abort -> MUST report AbortError
    const ext = new AbortController();
    fakeTts.speakWithTimestamps = async (_provider, { signal }) => {
      ext.abort();
      await new Promise((_res, rej) => {
        if (signal.aborted) return rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      });
    };
    fakeSettings.getKeyPoolDecrypted = () => [
      { id: 'k2', label: 'Key2', apiKey: 'el_key_2', enabled: true, quota: { remaining: 5000 }, status: 'ready' }
    ];

    await assert.rejects(
      () => pool.dispatchPoolTTS({
        chunks: ['Сайн байна уу, зогсоох туршилт.'],
        outDir: dir,
        resume: false,
        signal: ext.signal
      }),
      (err) => err.name === 'AbortError' && err.message.includes('Хэрэглэгч зогсоолоо')
    );
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../electron/elevenlabs-pool')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runAutoPipeline does not report canceled: true when user signal is not aborted', async () => {
  const dir = makeTempDir('cutline-nocancel-');
  const userData = path.join(dir, 'userdata');
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    const videoPath = path.join(dir, 'ep_nc.mp4');
    const srtPath = path.join(dir, 'ep_nc.srt');
    await makeSyntheticVideo(videoPath, 3.0);
    fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,500\nScene.\n', 'utf8');

    const controller = new AbortController();
    const res = await pipeline.runAutoPipeline({
      scriptText: 'Кредит дууссан үед цуцалсан гэж харагдах ёсгүй.',
      videoPath,
      srtPath,
      exportDir
    }, {
      app: makeMockApp(userData),
      signal: controller.signal,
      deps: {
        settings: createFakeSettings(),
        whisper: { status: () => ({ available: true, models: [{ id: 'groq-whisper-large-v3', installed: true }] }) },
        scriptStudio: {
          buildScriptRecap: async () => {
            // Even if internal lib threw AbortError, user controller was NOT aborted
            throw Object.assign(new Error('Request timeout'), { name: 'AbortError' });
          }
        }
      }
    });

    assert.equal(res.ok, false);
    assert.equal(res.canceled, false);
    assert.ok(res.error.includes('Request timeout'));
    const jobs = pipeline.listAutoPipelineJobs(makeMockApp(userData));
    assert.equal(jobs[0].status, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elevenlabs-pool skips 401/payment_issue broken key and fails over to healthy key', async () => {
  const Module = require('node:module');
  const dir = makeTempDir('cutline-failover-');
  const sampleAudio = path.join(dir, 'sample.mp3');
  await makeSyntheticAudio(sampleAudio, 1.5);
  const origLoad = Module._load;
  const statusUpdates = [];
  const fakeSettings = {
    getKeyPoolDecrypted: () => [
      { id: 'k_bad', label: 'KeyBad', apiKey: 'bad_api', enabled: true, quota: { remaining: 500 }, status: 'ready' },
      { id: 'k_good', label: 'KeyGood', apiKey: 'good_api', enabled: true, quota: { remaining: 5000 }, status: 'ready' }
    ],
    updateKeyPoolQuota: (id, _q, status) => statusUpdates.push({ id, status }),
    secret: () => ''
  };
  const fakeTts = {
    speakWithTimestamps: async (_provider, { apiKey, file }) => {
      if (apiKey === 'bad_api') {
        const err = new Error('ElevenLabs (401 / payment_issue): Your subscription has a failed or incomplete payment.');
        err.status = 401;
        err.code = 'payment_issue';
        throw err;
      }
      fs.copyFileSync(sampleAudio, file);
      return { file, duration: 1.5, sentences: [{ id: 0, text: 'Амжилттай.', start: 0, end: 1.5 }] };
    }
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: makeMockApp(dir), safeStorage: { isEncryptionAvailable: () => false } };
    }
    if (request === './settings' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeSettings;
    }
    if (request === './tts' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeTts;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../electron/elevenlabs-pool')];
    const pool = require('../electron/elevenlabs-pool');
    const results = await pool.dispatchPoolTTS({
      chunks: ['Энэ бол 401 алдаатай түлхүүрийг алгасах тест өгүүлбэр.'],
      outDir: dir,
      resume: false
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].keyUsed, 'KeyGood');
    assert.ok(statusUpdates.some((u) => u.id === 'k_bad' && u.status === 'blocked'));
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../electron/elevenlabs-pool')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatchPoolTTS recovers previously split cached sub-chunks without re-charging ElevenLabs credits', async () => {
  const Module = require('node:module');
  const dir = makeTempDir('cutline-split-resume-');
  const sampleAudio = path.join(dir, 'sample.mp3');
  await makeSyntheticAudio(sampleAudio, 1.2);
  const origLoad = Module._load;

  const sent1 = 'Энэ бол эхний урт өгүүлбэр бөгөөд динамикаар салгаж хадгалах хэсэг юм.';
  const sent2 = 'Харин энэ хоёр дахь хэсэг эхний түлхүүрийн үлдэгдэл хүрэлцэхгүй тул дараа нь уншигдана.';
  const fullChunk = `${sent1} ${sent2}`;

  let currentPool = [
    { id: 'k1', label: 'SmallKey', apiKey: 'api_small', enabled: true, quota: { remaining: 85 }, status: 'ready' }
  ];
  const synthesizedTexts = [];
  const fakeSettings = {
    getKeyPoolDecrypted: () => currentPool,
    updateKeyPoolQuota: (id, q, status) => {
      const target = currentPool.find((k) => k.id === id);
      if (target) {
        if (q) target.quota = q;
        if (status) target.status = status;
      }
    },
    secret: () => ''
  };
  const fakeTts = {
    speakWithTimestamps: async (_provider, { text, file }) => {
      synthesizedTexts.push(text);
      fs.copyFileSync(sampleAudio, file);
      return {
        file,
        duration: 1.2,
        sentences: [{ id: 0, text: text.trim(), start: 0, end: 1.2 }]
      };
    }
  };

  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: makeMockApp(dir), safeStorage: { isEncryptionAvailable: () => false } };
    }
    if (request === './settings' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeSettings;
    }
    if (request === './tts' && parent?.filename?.endsWith('elevenlabs-pool.js')) {
      return fakeTts;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../electron/elevenlabs-pool')];
    const pool = require('../electron/elevenlabs-pool');

    // Run 1: Key 1 has 75 credits -> splits chunk, reads sent1 (70 chars), leaves 5 credits, fails on sent2
    await assert.rejects(
      () => pool.dispatchPoolTTS({
        chunks: [fullChunk],
        outDir: dir,
        resume: true
      }),
      (err) => err.message.includes('хүрэлцэхгүй') || err.message.includes('дууссан')
    );
    assert.equal(synthesizedTexts.length, 1);
    assert.equal(synthesizedTexts[0], sent1);

    // Also remove *.split.json to prove SHA-256 sentence recovery works even on older cache dirs
    const resumeDir = path.join(dir, 'resume-v1');
    for (const f of fs.readdirSync(resumeDir)) {
      if (f.endsWith('.split.json')) fs.unlinkSync(path.join(resumeDir, f));
    }

    // Run 2: Add fresh Key 2 and resume -> must NOT re-synthesize sent1, ONLY sent2
    synthesizedTexts.length = 0;
    currentPool = [
      { id: 'k2', label: 'FreshKey', apiKey: 'api_fresh', enabled: true, quota: { remaining: 5000 }, status: 'ready' }
    ];

    const res = await pool.dispatchPoolTTS({
      chunks: [fullChunk],
      outDir: dir,
      resume: true
    });

    assert.equal(synthesizedTexts.length, 1, 'Previously cached split sub-chunk must not be re-synthesized');
    assert.equal(synthesizedTexts[0], sent2);
    assert.equal(res.length, 2);
    assert.equal(res[0].partSentences[0].text, sent1);
    assert.equal(res[1].partSentences[0].text, sent2);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../electron/elevenlabs-pool')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ff.exportTimeline with signal aborts only the signaled export without canceling a concurrent manual export', async () => {
  const dir = makeTempDir('cutline-exp-iso-');
  try {
    const videoPath = path.join(dir, 'src.mp4');
    await makeSyntheticVideo(videoPath, 4.0);
    const manualOut = path.join(dir, 'manual.mp4');
    const bgOut = path.join(dir, 'bg.mp4');

    const baseSpec = {
      clips: [{
        src: videoPath,
        trackId: 'v1',
        layer: 0,
        kind: 'video',
        opacity: 1,
        start: 0,
        inPoint: 0,
        outPoint: 4.0,
        hasAudio: true,
        volume: 1
      }],
      audio: [],
      overlays: [],
      width: 640,
      height: 360,
      fps: 24,
      duration: 4.0,
      codec: 'h264',
      quality: 'draft',
      format: 'mp4',
      audioBitrate: '128k'
    };

    const bgController = new AbortController();
    const manualPromise = ff.exportTimeline({ ...baseSpec, outPath: manualOut });
    const bgPromise = ff.exportTimeline({ ...baseSpec, outPath: bgOut }, () => {}, { signal: bgController.signal });

    setTimeout(() => bgController.abort(), 150);

    await assert.rejects(() => bgPromise);
    const manualResult = await manualPromise;
    assert.equal(manualResult, manualOut);
    assert.ok(fs.existsSync(manualOut) && fs.statSync(manualOut).size > 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
