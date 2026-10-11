/**
 * ElevenLabs v4 Audio Tags - Smart Mongolian Auto-Tagger
 * Automatically analyzes Mongolian narrative scripts, dialogues, emotions, actions,
 * and punctuation to insert natural ElevenLabs v4 audio acting tags.
 */

export interface AutoTagRule {
  tag: string;
  label: string;
  icon: string;
  pattern: RegExp;
  dialoguePunc?: RegExp;
  category: 'reaction' | 'emotion' | 'tone';
  priority: number; // Higher number = checked first
}

export const AUTO_TAG_RULES: AutoTagRule[] = [
  // 1. Shouting & Screaming (High intensity dialogue/narration)
  {
    tag: '[shouting]',
    label: 'Хашхирах',
    icon: '📢',
    pattern: /(хашхир|хашгир|орил|чарла|бархир|архир|зандар|хашгиран|орилон|чангаар орил|орилов|хашхирав|орилоод|хашхираад)/i,
    dialoguePunc: /[?!]{2,}|!{2,}/,
    category: 'tone',
    priority: 10
  },
  // 2. Angry & Rage
  {
    tag: '[angry]',
    label: 'Ууртай',
    icon: '😡',
    pattern: /(уурла|ууртай|хорсол|хорсон|цухалд|зангид|шүд зуун|хилэгнэ|хилэнтэй|уур нь хүрч|зэвүүц|зэвүүрх|уцаарла|чөтгөр аваг|зайл цаашаа|үхмээр байна уу|ална даа)/i,
    category: 'emotion',
    priority: 9
  },
  // 3. Whispers (Secret / quiet / covert)
  {
    tag: '[whispers]',
    label: 'Шивнэх',
    icon: '🤫',
    pattern: /(шивнэ|шивнэв|шивнэлээ|шивнэн|чишш|чимээгүйхэн|сэмхэн|сэмээрхэн|чихэнд нь шивнэ|хэнд ч битгий хэл|хэнд ч сонсогдохгүй|хэнд ч сонсогдож болохгүй|нууцаар|аниргүй)/i,
    category: 'reaction',
    priority: 9
  },
  // 4. Softly & Gentle
  {
    tag: '[softly]',
    label: 'Аяархан',
    icon: '🍃',
    pattern: /(зөөлнөөр|аядуу|энхрийл|дөлгөөн|тайтгаруулан|зөөлөн дуугаар|энхрий дуугаар|намуухан|аяархан хэл)/i,
    category: 'tone',
    priority: 6
  },
  // 5. Laughs (Burst of laughter)
  {
    tag: '[laughs]',
    label: 'Инээх',
    icon: '😆',
    pattern: /(инээд алд|тас тас инээ|хөхрөн|хөхрөв|чангаар инээ|haha|хаха|хэхэ|инээж гарлаа|элгээ хөшөө)/i,
    category: 'reaction',
    priority: 8
  },
  // 6. Chuckles (Smirk / irony / mock)
  {
    tag: '[chuckles]',
    label: 'Инээмсэглэх',
    icon: '😏',
    pattern: /(инээмсэгл|мушилз|жуумалз|шоол|егөөд|шоолон|мушилзан|ёжлон|ёжтой|дооглон|дооглож|шоолж)/i,
    category: 'reaction',
    priority: 7
  },
  // 7. Gasp (Shock / surprise / disbelief)
  {
    tag: '[gasp]',
    label: 'Цочих / Амьсгаа',
    icon: '😲',
    pattern: /(цочиж|цочин|цочоод|мэл гайх|гайхан|пал хийж|сүнс нь зайл|гэнэт хараад|нүд нь орой дээрээ гарч|байз даа|айн\?|юу гэнэ ээ|хөөх|хүүе ээ|яана аа)/i,
    dialoguePunc: /\?!|\?\!/,
    category: 'reaction',
    priority: 8
  },
  // 8. Sighs (Sigh / exhaustion / despair)
  {
    tag: '[sighs]',
    label: 'Санаа алдах',
    icon: '😮‍💨',
    pattern: /(санаа алд|санаа алдав|санаа алдан|санаашр|цөхөр|ядарч байна|ядарлаа|ээ бурхан минь|хайран юм|дэмий дээ|хөөрхий дөө|яана даа|арга мухардаж)/i,
    category: 'reaction',
    priority: 8
  },
  // 9. Voice Trembling (Shaking / terrified / crying speech)
  {
    tag: '[voice trembling]',
    label: 'Чичирсэн хоолой',
    icon: '🥺',
    pattern: /(хоолой нь чичир|хоолой чичрэн|чичирсэн хоолойгоор|уйлагнан|айн чичирч|дуу нь зангирч)/i,
    category: 'tone',
    priority: 8
  },
  // 10. Worried (Anxiety / fear)
  {
    tag: '[worried]',
    label: 'Зовсон / Сандарсан',
    icon: '😰',
    pattern: /(сандарч|сандран|түгшиж|айж|айн|айн ширвээдэж|яах вэ одоо|аймаар|аймшигтай|авраарай|зугтаарай|болгоомжтой|аюултай)/i,
    category: 'emotion',
    priority: 7
  },
  // 11. Excited (Thrilled / victory / celebration)
  {
    tag: '[excited]',
    label: 'Догдолсон',
    icon: '🤩',
    pattern: /(догдолж|догдлон|баяртайгаар|баярлан|гайхалтай|тийм ээ!|яллаа|болчихлоо|ашгүй дээ|үнэхээр гоё|ялалт|бахархалтайгаар|баярын нулимс)/i,
    category: 'emotion',
    priority: 7
  },
  // 12. Sad (Sorrow / crying / grief)
  {
    tag: '[sad]',
    label: 'Гунигтай',
    icon: '😢',
    pattern: /(уйлж|уйлан|нулимс дуслуул|гомдож|гунигтай|харамсалтай|шаналан|гашуун|эмгэнэлтэй|өрөвдмөөр|хагацал|уй гашуу)/i,
    category: 'emotion',
    priority: 7
  },
  // 13. Deep Breath (Gathering resolve / calming down)
  {
    tag: '[deep breath]',
    label: 'Гүн амьсгаа',
    icon: '🫁',
    pattern: /(гүн амьсгаа|гүнзгий амьсгаа ав|амьсгаагаа даран|тайвшрахыг хичээн|амьсгаагаа гарган)/i,
    category: 'reaction',
    priority: 6
  },
  // 14. Clears Throat (Formal / hesitation)
  {
    tag: '[clears throat]',
    label: 'Хоолой засах',
    icon: '🗣️',
    pattern: /(хоолойгоо засаж|хоолой засав|кхм|кх-кх|хоолойгоо цэвэрлэ)/i,
    category: 'reaction',
    priority: 6
  },
  // 15. Serious (Stern / grave / suspenseful)
  {
    tag: '[serious]',
    label: 'Нухацтай',
    icon: '🧐',
    pattern: /(нухацтай|хөмсөг зангидан|бодлогошрон|үнэндээ бол|хамгийн гол нь|анхааралтай сонс|тоглоом биш шүү|нууц нь юу вэ гэвэл)/i,
    category: 'emotion',
    priority: 5
  },
  // 16. Confident (Bold / proud / certain)
  {
    tag: '[confident]',
    label: 'Итгэлтэй',
    icon: '😎',
    pattern: /(итгэлтэйгээр|итгэл төгс|бардам|зоригтой|би чадна|мэдээж хэрэг|гарцаагүй|эргэлзээгүй)/i,
    category: 'emotion',
    priority: 5
  }
];

export interface AutoTagOptions {
  /**
   * 'balanced' = naturally spaces tags (~1 tag per 2-4 sentences to prevent acting fatigue)
   * 'dramatic' = tags nearly every sentence or dramatic beat
   */
  intensity?: 'balanced' | 'dramatic';
  /** Remove existing tags first if true */
  clearExisting?: boolean;
}

export interface AutoTagResult {
  text: string;
  tagsAdded: number;
  breakdown: Record<string, number>;
  details: { tag: string; snippet: string }[];
}

/**
 * Strips all ElevenLabs audio tags like [whispers], [laughs] from text.
 */
export function clearTagsFromScript(text: string): { text: string; removedCount: number } {
  const matches = text.match(/\[[a-zA-Z\s]{2,25}\]\s*/g) || [];
  const cleaned = text.replace(/\[[a-zA-Z\s]{2,25}\]\s*/g, '');
  return { text: cleaned, removedCount: matches.length };
}

/**
 * Count total audio tags present in text.
 */
export function countTagsInScript(text: string): number {
  return (text.match(/\[[a-zA-Z\s]{2,25}\]/g) || []).length;
}

/**
 * Intelligent Mongolian script analyzer & audio tagger.
 */
export function autoTagMongolianScript(rawScript: string, options: AutoTagOptions = {}): AutoTagResult {
  const { intensity = 'balanced', clearExisting = false } = options;

  let script = rawScript;
  if (clearExisting) {
    script = clearTagsFromScript(script).text;
  }

  const breakdown: Record<string, number> = {};
  const details: { tag: string; snippet: string }[] = [];
  let tagsAdded = 0;

  const paragraphs = script.split('\n');

  const processedParagraphs = paragraphs.map((para) => {
    if (!para.trim()) return para;

    // Sentence splitting by punctuation (. ! ? …) while preserving whitespace
    const parts = para.split(/([.!?…]+[\s]*)/);

    const sentences: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i];
      const punc = parts[i + 1] || '';
      if (text || punc) {
        sentences.push(text + punc);
      }
    }

    let lastTagIdx = -99;

    const taggedSentences = sentences.map((sentence, idx) => {
      const trimmed = sentence.trim();
      if (!trimmed || trimmed.length < 3) return sentence;

      // If sentence already has an audio tag, respect it and update index
      if (/\[[a-zA-Z\s]{2,25}\]/i.test(trimmed)) {
        lastTagIdx = idx;
        return sentence;
      }

      // In balanced mode, enforce pacing (at least 1 sentence distance between tags)
      if (intensity === 'balanced' && (idx - lastTagIdx < 2)) {
        return sentence;
      }

      let chosenTag: string | null = null;

      // 1. Check for Mongolian dialogue quote: e.g. "..." гэж хашхирав / хэмээн инээв
      const quoteMatch = /(["“«][^"”»]+["”»])/.exec(trimmed);
      if (quoteMatch) {
        const quoteText = quoteMatch[1];
        const quotePos = trimmed.indexOf(quoteText);
        const afterQuote = trimmed.slice(quotePos + quoteText.length);

        // Check reporting verb directly after quote: "..." гэж хашхирав
        for (const rule of AUTO_TAG_RULES) {
          if (rule.pattern && rule.pattern.test(afterQuote)) {
            chosenTag = rule.tag;
            break;
          }
        }

        // If no after-cue, check quote content & punctuation
        if (!chosenTag) {
          for (const rule of AUTO_TAG_RULES) {
            if (rule.pattern && rule.pattern.test(quoteText)) {
              chosenTag = rule.tag;
              break;
            }
            if (rule.dialoguePunc && rule.dialoguePunc.test(quoteText)) {
              chosenTag = rule.tag;
              break;
            }
          }
        }

        if (chosenTag) {
          tagsAdded++;
          breakdown[chosenTag] = (breakdown[chosenTag] || 0) + 1;
          details.push({ tag: chosenTag, snippet: trimmed.slice(0, 45) });
          lastTagIdx = idx;

          // Insert right in front of the dialogue quote
          return sentence.replace(quoteText, `${chosenTag} ${quoteText}`);
        }
      }

      // 2. Narrative sentence: check rules against entire sentence
      if (!chosenTag) {
        for (const rule of AUTO_TAG_RULES) {
          if (rule.pattern && rule.pattern.test(trimmed)) {
            chosenTag = rule.tag;
            break;
          }
        }
      }

      if (chosenTag) {
        tagsAdded++;
        breakdown[chosenTag] = (breakdown[chosenTag] || 0) + 1;
        details.push({ tag: chosenTag, snippet: trimmed.slice(0, 45) });
        lastTagIdx = idx;

        // Insert at the beginning of the sentence
        const leadingWhitespace = sentence.match(/^\s*/)?.[0] || '';
        const rest = sentence.slice(leadingWhitespace.length);
        return `${leadingWhitespace}${chosenTag} ${rest}`;
      }

      return sentence;
    });

    return taggedSentences.join('');
  });

  return {
    text: processedParagraphs.join('\n'),
    tagsAdded,
    breakdown,
    details
  };
}
