'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.test-output/elevenlabs-credit'); fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
(async () => {
 const app = await _electron.launch({ executablePath: path.join(root, 'release/Cutline/Cutline.exe'), cwd: root,
  env: { ...process.env, CUTLINE_TEST_DIR: profile } });
 try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  await app.evaluate(({ ipcMain }) => {
   globalThis.fetch = async () => { throw new Error('Network is disabled for this test'); };
   const replace = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn); };
   replace('eleven:getPool', () => Array.from({ length: 23 }, (_, i) => ({ id: `fake-${i}`, label: `Key ${i + 1}`, enabled: true,
    status: ['exhausted', 'exhausted', 'insufficient', 'blocked', 'exhausted', 'ready'][i] || 'ready',
    quota: i === 5 ? null : { userId: `test-account-${i}`, used: 10000 - ([712, 1410, 2075, 5000, 0][i] ?? 9000), limit: 10000,
      remaining: globalThis.studioCalls ? 309 : ([712, 1410, 2075, 5000, 0][i] ?? 9000) } })));
   replace('tts:voices', () => ({ ok: true, voices: [{ id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Test voice' }] }));
   globalThis.studioCalls = 0;
   replace('script:pickAudioFolder', () => ({ ok: true, dir: 'Test audio folder', token: 'folder', parts: [{ name: '1.mp3' }, { name: '2.wav' }, { name: '10.mp3' }] }));
   globalThis.folderCalls = 0;
   replace('script:mergeAudioFolder', (_e, token) => { if (token !== 'folder') throw new Error('Wrong folder'); globalThis.folderCalls++; return { ok: true, canceled: true }; });
   replace('script:scanRecovery', () => ({ ok: true, token: 'test', parts: [{ name: 'part0', index: 0 }, { name: 'part2', index: 2 }], missing: [2], ambiguous: false, startedAt: 1790583229020 }));
   globalThis.recoveryCalls = 0;
   replace('script:mergeRecovery', (_e, spec) => { globalThis.recoveryCalls++; if (spec.token !== 'test' || !spec.allowGaps) throw new Error('Invalid recovery request'); return { ok: false, error: 'Recovery test: changed files' }; });
   replace('script:buildRecap', () => { globalThis.studioCalls++; return { ok: false,
    error: 'Key 1: ElevenLabs (401 / missing_permissions): Text to speech permission is missing.\nКредит дууссан гэж тэмдэглээгүй.' }; });
  });
  await page.getByText('Create project', { exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('open-script-studio')));
  await page.getByText(/23 Түлхүүр Идэвхтэй/).waitFor();
  await page.getByRole('button', { name: 'Хавтас сонгох — нэрээр нэгтгэх', exact: true }).click();
  await page.getByText('Test audio folder', { exact: false }).waitFor();
  assert.deepEqual(await page.locator('ol li').allTextContents(), ['1.mp3', '2.wav', '10.mp3']);
  await page.getByRole('button', { name: 'Нэрийн дарааллаар нэгтгэж хадгалах', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.folderCalls), 1);
  await page.getByRole('button', { name: 'Сүүлийн аудио хэсгүүдийг шалгах', exact: true }).click();
  await page.getByText(/Дутуу дугаар: 2/).waitFor();
  await page.getByRole('button', { name: 'Байгаа хэсгүүдийг дарааллаар нэгтгэх', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Recovery test: changed files' }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.recoveryCalls), 1);
  assert.equal(await app.evaluate(() => globalThis.studioCalls), 0, 'Recovery does not invoke paid synthesis');
  await page.getByRole('button', { name: /Түлхүүрийн сан \(23\)/ }).click();
  const row = n => page.getByText(`Key ${n}`, { exact: true }).locator('..').locator('..');
  assert.match(await row(1).innerText(), /Төлөв шинэчлэх шаардлагатай/);
  assert.match(await row(1).innerText(), /712/); assert.doesNotMatch(await row(1).innerText(), /Кредит дууссан/);
  assert.match(await row(2).innerText(), /1,410/); assert.doesNotMatch(await row(2).innerText(), /Кредит дууссан/);
  assert.match(await row(3).innerText(), /Өмнөх хэсэгт кредит хүрээгүй/);
  assert.match(await row(4).innerText(), /API эрх хязгаарлагдсан/);
  assert.match(await row(5).innerText(), /Кредит дууссан/);
  assert.match(await row(6).innerText(), /Үлдэгдэл шалгагдаагүй/);
  await page.screenshot({ path: path.join(dir, 'accurate-key-statuses.png') });
  await page.getByRole('button', { name: /Сан хураах/ }).click();
  await page.locator('textarea').fill('Монгол текст. '.repeat(8000).slice(0, 90134));
  const start = page.getByRole('button', { name: /Зөвхөн хоолой үүсгэх \(/ });
  assert.equal(await start.isEnabled(), true, 'Sufficient displayed balance allows generation');
  await start.click();
  const alert = page.getByRole('alert'); await alert.waitFor();
  assert.match(await alert.innerText(), /missing_permissions/);
  assert.equal(await alert.evaluate(el => document.activeElement === el), true);
  assert.ok(await alert.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'Error is scrolled into the visible window');
  assert.equal(await app.evaluate(() => globalThis.studioCalls), 1);
  await page.getByText(/Үлдэгдэл хүрэлцэхгүй байж болзошгүй/).waitFor();
  assert.equal(await start.isEnabled(), true, 'A reduced balance must not block resuming already cached audio');
  await page.screenshot({ path: path.join(dir, 'permission-error-visible.png') });
  console.log('PASS: positive/zero/unknown balances, legacy/insufficient/blocked statuses, and visible permission error; no live API calls.');
 } catch (error) {
  const page = await app.firstWindow();
  console.log((await page.locator('body').innerText()).slice(-4500));
  await page.screenshot({ path: path.join(dir, 'failure.png') });
  throw error;
 } finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {});
  await app.close().catch(() => {});
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
