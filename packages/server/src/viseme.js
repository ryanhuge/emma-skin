/**
 * Audio → mouth shape curve.
 *
 * Two drivers, because the good one costs a 400MB download and the first run should not.
 *
 *   OnnxViseme    an audio-to-expression model, via the sidecar in packages/viseme.
 *                 Distinguishes rounded from spread lips, and closes on consonants.
 *   EnergyViseme  a loudness envelope. No model, no service, no install. Openness tracks
 *                 volume, which is roughly right for vowels and wrong for everything else —
 *                 good enough to see the thing work, not good enough to ship.
 *
 * Both return the same shape: three arrays sampled at `fps`, each 0..1.
 *
 *   { fps: 30, mouth: { openness: [...], width: [...], roundness: [...] } }
 */

const DEFAULT_FPS = 30;

export class OnnxViseme {
  constructor({ url = 'http://127.0.0.1:9002', timeoutMs = 8000 } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async available() {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch { return false; }
  }

  async extract(pcm, sampleRate) {
    const res = await fetch(`${this.url}/viseme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcmToWav(pcm, sampleRate),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`viseme service ${res.status}`);
    return res.json();
  }
}

/**
 * Loudness envelope, computed here rather than downloaded.
 *
 * Deliberately crude. Openness follows a smoothed RMS; width and roundness stay near rest
 * because loudness says nothing about lip shape. Do not mistake this for lip sync — it is
 * a mouth that moves while sound happens, which is enough to check that audio, timing and
 * rendering all line up.
 */
export class EnergyViseme {
  constructor({ fps = DEFAULT_FPS, floorDb = -50 } = {}) {
    this.fps = fps;
    this.floorDb = floorDb;
  }

  async available() { return true; }

  async extract(pcm, sampleRate) {
    const samples = toInt16(pcm);
    const per = Math.max(1, Math.round(sampleRate / this.fps));
    const frames = Math.ceil(samples.length / per);
    const openness = new Array(frames);

    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const start = f * per;
      const end = Math.min(samples.length, start + per);
      for (let i = start; i < end; i++) {
        const v = samples[i] / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      // dB maps loudness onto something perceptually even; linear RMS spends most of its
      // range on the loudest few frames.
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      openness[f] = Math.max(0, Math.min(1, (db - this.floorDb) / -this.floorDb));
    }

    // A jaw has mass; an unsmoothed envelope chatters at every consonant.
    let smoothed = openness.map((v, i, a) => {
      const lo = Math.max(0, i - 1), hi = Math.min(a.length - 1, i + 1);
      return (a[lo] + v + a[hi]) / 3;
    });

    // Stretch this utterance onto the full range. A fixed dB floor leaves a normal speaking
    // level sitting around a third of the scale, and the renderer then scales it down again
    // — the mouth barely moved (measured peak 0.27 against 0.55 from the model). The ONNX
    // path is calibrated against a reference recording; this is the same idea per utterance.
    const peak = Math.max(...smoothed);
    if (peak > 0.05) smoothed = smoothed.map((v) => Math.min(1, v / peak));

    return {
      fps: this.fps,
      mouth: {
        openness: smoothed,
        width: smoothed.map(() => 0.35),
        roundness: smoothed.map(() => 0.25),
      },
    };
  }
}

/** Pick the model if its service is up, otherwise fall back and say so once. */
export async function autoViseme(opts = {}) {
  const onnx = new OnnxViseme(opts);
  if (await onnx.available()) return onnx;
  console.warn('[emma-skin] viseme service not reachable — falling back to the loudness '
    + 'envelope. Lip sync will be approximate; see packages/viseme/README.md.');
  return new EnergyViseme(opts);
}

function toInt16(pcm) {
  if (pcm instanceof Int16Array) return pcm;
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** Wrap raw PCM in a 44-byte RIFF header so a decoder can read it. */
export function pcmToWav(pcm, sampleRate, { channels = 1, bitDepth = 16 } = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(toInt16(pcm).buffer);
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitDepth) / 8, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
