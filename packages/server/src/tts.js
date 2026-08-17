/**
 * Voices.
 *
 * Every TTS here returns raw PCM rather than playing anything, because the mouth curve has
 * to be computed from the exact samples that will be heard. See host.js for why that is the
 * one non-negotiable part of the interface.
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Strip a RIFF header and return the sample data plus its rate. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a RIFF wav');
  }
  let sampleRate = 16000;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(pos + 12);
    if (id === 'data') return { pcm: buf.subarray(pos + 8, pos + 8 + size), sampleRate };
    pos += 8 + size + (size % 2);
  }
  throw new Error('wav has no data chunk');
}

/**
 * macOS's built-in speech synthesis.
 *
 * Included because it makes the first run free: no account, no API key, no model download.
 * The voice is not as good as a commercial one, but it proves the whole chain works before
 * anyone has to sign up for anything.
 *
 *   Voices:  say -v '?'
 */
export class SayTTS {
  constructor({ voice = '', rate = 0, sampleRate = 22050 } = {}) {
    this.voice = voice;
    this.rate = rate;
    this.sampleRate = sampleRate;
  }

  static get available() { return process.platform === 'darwin'; }

  async synthesize(text) {
    const dir = await mkdtemp(join(tmpdir(), 'emma-skin-'));
    const out = join(dir, 'out.wav');
    try {
      const args = [
        ...(this.voice ? ['-v', this.voice] : []),
        ...(this.rate ? ['-r', String(this.rate)] : []),
        '-o', out,
        '--data-format=LEI16@' + this.sampleRate,
        text,
      ];
      await run('say', args, { timeout: 30000 });
      return parseWav(await readFile(out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * espeak-ng, the equivalent zero-key option on Linux.
 *
 * It sounds robotic — that is not a flaw to apologise for, it is a diagnostic voice. It
 * proves the audio path, the timing and the mouth curve all work before anyone signs up for
 * a hosted voice.
 *
 *   apt install espeak-ng   /   brew install espeak-ng
 */
export class EspeakTTS {
  constructor({ voice = 'cmn', speed = 160, sampleRate = 22050 } = {}) {
    Object.assign(this, { voice, speed, sampleRate });
  }

  static get available() {
    return spawnSync('espeak-ng', ['--version']).status === 0;
  }

  async synthesize(text) {
    const dir = await mkdtemp(join(tmpdir(), 'emma-skin-'));
    const out = join(dir, 'out.wav');
    try {
      await run('espeak-ng', ['-v', this.voice, '-s', String(this.speed), '-w', out, text],
        { timeout: 30000 });
      return parseWav(await readFile(out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Fish Audio, as an example of a hosted voice with cloning.
 *
 * Note on licensing before you ship anything with it: commercial rights come with a paid
 * plan, and cloning a voice requires the consent of whoever owns it. EMMA Skin bundles no
 * account and no voice — supply your own key and reference id.
 */
export class FishAudioTTS {
  constructor({ apiKey, referenceId = '', model = 's1', sampleRate = 44100 }) {
    if (!apiKey) throw new Error('FishAudioTTS needs an apiKey');
    this.apiKey = apiKey;
    this.referenceId = referenceId;
    this.model = model;
    this.sampleRate = sampleRate;
  }

  async synthesize(text) {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        model: this.model,
      },
      body: JSON.stringify({
        text,
        format: 'pcm',
        sample_rate: this.sampleRate,
        ...(this.referenceId ? { reference_id: this.referenceId } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`fish audio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return { pcm: Buffer.from(await res.arrayBuffer()), sampleRate: this.sampleRate };
  }
}

/**
 * Anything that speaks the OpenAI /v1/audio/speech dialect.
 *
 * Asks for wav rather than mp3 on purpose: decoding mp3 server-side would mean a codec
 * dependency, and the samples are needed as PCM anyway.
 */
export class OpenAITTS {
  constructor({ baseUrl = 'https://api.openai.com', apiKey, model = 'tts-1', voice = 'nova' }) {
    if (!apiKey) throw new Error('OpenAITTS needs an apiKey');
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, voice });
  }

  async synthesize(text) {
    const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: 'wav' }),
    });
    if (!res.ok) {
      throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return parseWav(Buffer.from(await res.arrayBuffer()));
  }
}
