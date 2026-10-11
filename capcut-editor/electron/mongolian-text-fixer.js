'use strict';
const whisper = require('./whisper');

/**
 * Deterministic dictionary and regex-based corrections for common
 * Whisper speech-to-text misspellings in Mongolian.
 */
const REPLACEMENTS = [
  // Common verbal contractions & mishearings
  [/\bбаина\b/gi, 'байна'],
  [/\bбаин\b/gi, 'байна'],
  [/\bбаихгүй\b/gi, 'байхгүй'],
  [/\bбайхгуй\b/gi, 'байхгүй'],
  [/\bбаихгуй\b/gi, 'байхгүй'],
  [/\bболсонгуй\b/gi, 'болсонгүй'],
  [/\bболсонгvй\b/gi, 'болсонгүй'],
  [/\bболосон\b/gi, 'болсон'],
  [/\bболохоор\b/gi, 'болохоор'],
  [/\bхиисэн\b/gi, 'хийсэн'],
  [/\bхийгээгүи\b/gi, 'хийгээгүй'],
  [/\bхийж баина\b/gi, 'хийж байна'],
  [/\bүзэж баина\b/gi, 'үзэж байна'],
  [/\bбодож баина\b/gi, 'бодож байна'],
  [/\bяваад баина\b/gi, 'яваад байна'],
  [/\bхэлж баина\b/gi, 'хэлж байна'],
  [/\bирж баина\b/gi, 'ирж байна'],
  [/\bөгч баина\b/gi, 'өгч байна'],
  [/\bавч баина\b/gi, 'авч байна'],

  // Pronouns and common particles
  [/\bтиим\b/gi, 'тийм'],
  [/\bтиимээс\b/gi, 'тиймээс'],
  [/\bтиймэс\b/gi, 'тиймээс'],
  [/\bүгүи\b/gi, 'үгүй'],
  [/\bүгуй\b/gi, 'үгүй'],
  [/\bминии\b/gi, 'миний'],
  [/\bчинии\b/gi, 'чиний'],
  [/\bтүүнии\b/gi, 'түүний'],
  [/\bтэднии\b/gi, 'тэдний'],
  [/\bбиднии\b/gi, 'бидний'],
  [/\bөөриигөө\b/gi, 'өөрийгөө'],
  [/\bөөрсдиигөө\b/gi, 'өөрсдийгөө'],

  // Adjectives / nouns with й / и
  [/\bтухаи\b/gi, 'тухай'],
  [/\bбичлэгиин\b/gi, 'бичлэгийн'],
  [/\bсонирхолтои\b/gi, 'сонирхолтой'],
  [/\bгайхалтои\b/gi, 'гайхалтай'],
  [/\bхүчтэи\b/gi, 'хүчтэй'],
  [/\bаюултаи\b/gi, 'аюултай'],
  [/\bяряхаар\b/gi, 'ярихаар'],
  [/\bшиидлээ\b/gi, 'шийдлээ'],
  [/\bшиидсэн\b/gi, 'шийдсэн'],
  [/\bэргэлзээгүи\b/gi, 'эргэлзээгүй'],

  // Punctuation & spaces
  [/\s+([,.?!:;])/g, '$1'],
  [/([,.?!:;])([^\s,.?!:;0-9])/g, '$1 $2'],
  [/\s{2,}/g, ' ']
];

/**
 * Fast deterministic spell and formatting pass for Mongolian text.
 */
function normalizeMongolianSpelling(text) {
  if (!text || typeof text !== 'string') return '';
  let res = text.trim();
  for (const [pattern, replacement] of REPLACEMENTS) {
    res = res.replace(pattern, replacement);
  }
  // Ensure starts with capital letter if appropriate
  if (res.length > 0 && /^[a-zа-яёөү]/.test(res)) {
    res = res.charAt(0).toUpperCase() + res.slice(1);
  }
  return res;
}

/**
 * System prompt to feed into Groq Whisper to condition decoding on proper Mongolian Cyrillic.
 */
const MONGOLIAN_WHISPER_PROMPT =
  'Монгол хэл дээрх албан ёсны хадмал, яриа, бичвэр. Зөв бичих дүрэм, эгшиг зохицол, өгүүлбэрийн цэг таслал: би, чи, тэр, бид, та нар, тэд, байна, байсан, болсон, хийсэн, үзсэн, хэлсэн, өгсөн, авсан, яагаад, яаж, хэзээ, хаана, юу, хэн, ямар, тийм, үгүй, харин, бөгөөд, гэвч.';

/**
 * AI-powered grammar and spelling repair for an array of subtitle segments.
 * Uses Groq LPU (qwen/qwen3.8-27b) in 0.8-1.5s.
 */
async function polishMongolianCaptionsWithAI(segments, { signal, onProgress, apiKey } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;

  // First apply instant deterministic spell check to all
  const normalized = segments.map((s) => ({
    ...s,
    text: normalizeMongolianSpelling(s.text)
  }));

  const keys = apiKey ? [apiKey] : whisper.getGroqKeys();
  if (!keys.length) {
    return normalized;
  }

  const BATCH_SIZE = 40;
  const totalBatches = Math.ceil(normalized.length / BATCH_SIZE);
  let activeKeyIndex = 0;

  for (let b = 0; b < totalBatches; b++) {
    signal?.throwIfAborted();
    const startIdx = b * BATCH_SIZE;
    const batch = normalized.slice(startIdx, startIdx + BATCH_SIZE);
    const rawLines = batch.map((item) => item.text);

    onProgress?.({
      stage: 'ai_polish',
      pct: 95 + Math.round(((b + 1) / totalBatches) * 4),
      message: `✨ AI: Монгол хэлний найруулга, алдааг засаж байна (${b + 1}/${totalBatches})...`
    });

    try {
      const prompt = `Та бол Монгол хэлний шилдэг редактор. Өгөгдсөн ярианаас таньсан хадмал текстийн үг үсгийн алдаа, эгшиг зохицол, зөв бичих дүрмийг засаж, цэг таслалыг зөв тавина уу. Мөрийн утга, дараалал, тоог өөрчлөхгүйгээр мөр бүрийг засна.
Хариугаа ЗӨВХӨН дараах JSON хэлбэрээр буцаана:
{"corrected": ["мөр 1", "мөр 2"]}

Эх мөрүүд:
${JSON.stringify(rawLines, null, 2)}`;

      const currentKey = keys[activeKeyIndex % keys.length];
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.8-27b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }),
        signal
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          const correctedList = Array.isArray(parsed.corrected) ? parsed.corrected : (Array.isArray(parsed) ? parsed : null);
          if (correctedList && correctedList.length === batch.length) {
            for (let i = 0; i < batch.length; i++) {
              const fixed = String(correctedList[i] || '').trim();
              if (fixed && fixed.length > 0 && Math.abs(fixed.length - batch[i].text.length) < 40) {
                normalized[startIdx + i].text = fixed;
              }
            }
          }
        }
      } else if (res.status === 429) {
        activeKeyIndex++;
      }
    } catch (err) {
      console.warn('[MongolianTextFixer] AI polish batch warning:', err.message);
      // Fallback silently to normalized text
    }
  }

  return normalized;
}

module.exports = {
  normalizeMongolianSpelling,
  MONGOLIAN_WHISPER_PROMPT,
  polishMongolianCaptionsWithAI
};
