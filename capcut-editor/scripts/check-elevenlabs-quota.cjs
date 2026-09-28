'use strict';
// Read-only: never prints keys and never synthesizes speech or changes settings.
const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(process.env.APPDATA, 'Cutline'));
app.whenReady().then(async () => {
 const settings = require('../electron/settings');
 const { fetchKeyQuota } = require('../electron/elevenlabs-pool');
 const keys = settings.getKeyPoolDecrypted(), results = [];
 if (!keys.length) throw new Error('No enabled credentials could be decrypted in this process. Balance is unknown, not zero. Use the running app credit refresh.');
 let cursor = 0;
 await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < keys.length) {
   const index = cursor++, item = keys[index];
   const live = await fetchKeyQuota(item.apiKey);
   results[index] = { index: index + 1, cached: item.quota?.remaining ?? null,
    valid: live.valid, remaining: live.remaining ?? null, error: live.error };
  }
 }));
 console.log(JSON.stringify({ keys: results, cachedTotal: results.reduce((n, r) => n + (r.cached || 0), 0),
  liveTotal: results.reduce((n, r) => n + (r.remaining || 0), 0) }, null, 2));
 app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
