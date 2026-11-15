const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 22050;
const DURATION_S = 1.6;
const PEAK = 0.35;
const ATTACK_S = 0.012;
const DECAY_S = 0.45;
const TONES = [
  { start: 0, frequency: 783.99 },
  { start: 0.38, frequency: 659.25 },
];
const PARTIALS = [
  { multiple: 1, level: 1 },
  { multiple: 2, level: 0.18 },
  { multiple: 3, level: 0.05 },
];

function envelope(t) {
  if (t < 0) return 0;
  const attack = Math.min(t / ATTACK_S, 1);
  return attack * Math.exp(-t / DECAY_S);
}

function mixAt(t) {
  let sum = 0;
  for (const tone of TONES) {
    const local = t - tone.start;
    const level = envelope(local);
    if (level === 0) continue;
    for (const partial of PARTIALS) {
      sum +=
        level * partial.level * Math.sin(2 * Math.PI * tone.frequency * partial.multiple * local);
    }
  }
  return sum;
}

function render() {
  const count = Math.round(SAMPLE_RATE * DURATION_S);
  const raw = new Float64Array(count);
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    raw[i] = mixAt(i / SAMPLE_RATE);
    max = Math.max(max, Math.abs(raw[i]));
  }
  const fadeStart = count - Math.round(SAMPLE_RATE * 0.05);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    const fade = i < fadeStart ? 1 : (count - i) / (count - fadeStart);
    samples[i] = Math.round((raw[i] / max) * PEAK * fade * 32767);
  }
  return samples;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, 44 + i * 2));
  return buffer;
}

const out = path.join(__dirname, '..', 'assets', 'sounds', 'chime.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, toWav(render()));
console.log(`Wrote ${out}`);
