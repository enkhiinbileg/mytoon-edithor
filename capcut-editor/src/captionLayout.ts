// Subdivision uses estimated intra-segment times. Script words are never rewritten.
export function layoutCaptions<T extends { text: string; start: number; duration: number }>(segments: T[]): T[] {
  return segments.flatMap(segment => {
    const words = segment.text.trim().split(/\s+/).filter(Boolean);
    const groups: string[] = [];
    let current = '';
    for (const word of words) {
      if (current && (current.length + word.length + 1 > 72 || current.split(' ').length >= 10)) { groups.push(current); current = ''; }
      current = current ? current + ' ' + word : word;
    }
    if (current) groups.push(current);
    const total = groups.reduce((sum, text) => sum + text.length, 0);
    let offset = 0;
    return groups.map((text, i) => {
      const start = segment.start + offset / total * segment.duration;
      offset += text.length;
      const end = i === groups.length - 1 ? segment.start + segment.duration : segment.start + offset / total * segment.duration;
      if (text.length > 36) {
        const spaces = [...text.matchAll(/ /g)].map(match => match.index!);
        const split = spaces.sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2))[0];
        if (split !== undefined) text = text.slice(0, split) + '\n' + text.slice(split + 1);
      }
      return { ...segment, text, start, duration: end - start };
    });
  });
}
