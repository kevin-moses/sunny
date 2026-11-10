// sunny_app/scripts/makeChime.js
//
// Purpose: Synthesizes the home display's due cue chime (assets/sounds/chime.wav) so the sound
// is our own, not third-party audio. Two soft bell tones a major third apart (G5 then E5),
// each a sine with two quiet overtones, a short fade-in and a slow exponential fade-out, mixed
// at a modest level (peak about -9 dBFS) so it is noticeable without startling. Writes a
// 22.05 kHz, 16-bit, mono WAV of about 1.6 seconds. Deterministic: the same file every run.
//
// Run from sunny_app: node scripts/makeChime.js
//
// Last modified: 2026-11-09

/* global Buffer, __dirname */

const fs = require('fs');
const path = require('path');

/** Samples per second. */
const SAMPLE_RATE = 22050;
/** Total length in seconds. */
const DURATION_S = 1.6;
/** Peak level of the mix, as a fraction of full scale (about -9 dBFS). */
const PEAK = 0.35;
/** Fade-in of each tone in seconds, long enough to avoid a click. */
const ATTACK_S = 0.012;
/** Exponential decay time constant of each tone in seconds. */
const DECAY_S = 0.45;
/** The tones: start time (s) and fundamental frequency (Hz). */
const TONES = [
  { start: 0, frequency: 783.99 },
  { start: 0.38, frequency: 659.25 },
];
/** Overtones of a tone: frequency multiple and relative level. */
const PARTIALS = [
  { multiple: 1, level: 1 },
  { multiple: 2, level: 0.18 },
  { multiple: 3, level: 0.05 },
];

/**
 * purpose: The level of one tone at a time after its start: a linear fade-in, then an
 *          exponential decay.
 * @param t: (number) Seconds since the tone started; negative before it starts.
 * @return: (number) The envelope, 0 to 1.
 */
function envelope(t) {
  if (t < 0) return 0;
  const attack = Math.min(t / ATTACK_S, 1);
  return attack * Math.exp(-t / DECAY_S);
}

/**
 * purpose: The unscaled sample of the mix at a time.
 * @param t: (number) Seconds from the start of the file.
 * @return: (number) The sample before normalization.
 */
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

/**
 * purpose: Render the chime as 16-bit samples normalized to PEAK, with the last 50 ms faded
 *          to silence so the file ends cleanly.
 * @return: (Int16Array) The samples.
 */
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

/**
 * purpose: Wrap 16-bit mono samples in a RIFF/WAVE container.
 * @param samples: (Int16Array) The samples.
 * @return: (Buffer) The WAV file bytes.
 */
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
