#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const srtParser = require('../capcut-editor/electron/srt-parser.js');

function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log('====================================================');
  console.log('   Cutline SRT Slicer & Zero-Offset Aligner Tool   ');
  console.log('====================================================\n');

  let srtPath = process.argv[2];
  let startTime = process.argv[3];
  let endTime = process.argv[4];

  if (!srtPath) {
    srtPath = await ask('📂 SRT файлын замыг оруулна уу (эсвэл чирж тавина уу): ');
    srtPath = srtPath.replace(/^["']/, '').replace(/["']$/, '');
  }

  if (!fs.existsSync(srtPath)) {
    console.error(`❌ Алдаа: SRT файл олдсонгүй: ${srtPath}`);
    process.exit(1);
  }

  if (!startTime) {
    startTime = await ask('⏱️ Эхлэх цагийг оруулна уу (Жишээ нь: 02:00:08 эсвэл 7208): ');
  }

  if (!endTime) {
    endTime = await ask('⏱️ Дуусах цагийг оруулна уу (Хоосон орхивол дуустал): ');
  }

  console.log('\n🔍 SRT файлыг уншиж байна...');
  const raw = srtParser.parseSrtFile(srtPath);
  console.log(`✓ Нийт ${raw.length} мөр хадмал олдлоо.`);

  console.log(`✂️ ${startTime} цагаас эхлэн тасалж 00:00:00 болгон шилжүүлж байна...`);
  const { startSec, endSec, entries } = srtParser.sliceAndShiftSrt(raw, startTime, endTime);

  if (!entries.length) {
    console.error('❌ Алдаа: Заасан цагийн хооронд ямар ч хадмал олдсонгүй.');
    process.exit(1);
  }

  console.log(`✓ Үлдсэн хадмалын тоо: ${entries.length} мөр.`);
  const sentences = srtParser.reconstructSentences(entries);
  console.log(`✓ Нэгтгэсэн бүтэн өгүүлбэрийн тоо: ${sentences.length} өгүүлбэр.`);

  const dir = path.dirname(srtPath);
  const baseName = path.basename(srtPath, path.extname(srtPath));
  const cleanTag = `from_${String(startTime).replace(/[:.]/g, '_')}`;

  const outSrtPath = path.join(dir, `${baseName}_${cleanTag}_synced.srt`);
  const outTxtPath = path.join(dir, `${baseName}_${cleanTag}_script.txt`);

  const srtContent = srtParser.stringifySrt(entries);
  fs.writeFileSync(outSrtPath, srtContent, 'utf8');
  console.log(`\n💾 Шинэ 00:00:00 болгосон SRT хадгалагдлаа:\n   👉 ${outSrtPath}`);

  const txtContent = sentences.map((s, idx) => `${idx + 1}. ${s.text}`).join('\n\n');
  fs.writeFileSync(outTxtPath, txtContent, 'utf8');
  console.log(`\n📄 Орчуулахад бэлэн Англи скрипт хадгалагдлаа:\n   👉 ${outTxtPath}`);

  console.log('\n====================================================');
  console.log('✨ Бэлэн боллоо!');
  console.log('1. Энэхүү *_script.txt файлыг Монгол руу орчуулж ElevenLabs-аар уншуулна.');
  console.log('2. Шинэ *_synced.srt файлыг Cutline Editor-ийн Auto Sync-д хийхэд 100% яв цав таарна.');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('Алдаа:', err);
  process.exit(1);
});
