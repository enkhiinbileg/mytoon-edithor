'use strict';
module.exports = function wave(duration, ranges = [[0, duration]]) {
  const rate = 16000, samples = Math.round(duration * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (const [start, end] of ranges) {
    for (let i = Math.max(0, Math.floor(start * rate)); i < Math.min(samples, end * rate); i++) {
      buffer.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
    }
  }
  return buffer;
};
