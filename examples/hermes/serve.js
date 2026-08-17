/**
 * Give Hermes a face.
 *
 * Hermes speaks the OpenAI chat dialect and streams, which is the whole integration — the
 * adapter adds one thing on top, forwarding its `hermes.tool.progress` events so she looks
 * thoughtful while it is actually working rather than on a timer.
 *
 * On a Mac this needs no API key for speech: `say` is used for the voice. Point HERMES_URL
 * at the agent, run it, open the page.
 *
 *   HERMES_URL=http://127.0.0.1:8642 HERMES_KEY=... node examples/hermes/serve.js
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createEmmaSkinServer } from '../../packages/server/src/server.js';
import { OnnxViseme } from '../../packages/server/src/viseme.js';
import { HermesHost } from '../../packages/server/src/host.js';
import { SayTTS, EspeakTTS, FishAudioTTS, OpenAITTS } from '../../packages/server/src/tts.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const host = new HermesHost({
  baseUrl: process.env.HERMES_URL || 'http://127.0.0.1:8642',
  apiKey: process.env.HERMES_KEY || '',
  // Spoken replies are not written replies. Without this the agent produces bullet lists
  // and headings, and a TTS engine reads the punctuation out loud.
  systemPrompt: 'You are speaking out loud, not writing. Reply in short spoken sentences. '
    + 'No markdown, no lists, no headings, no emoji. Keep the first sentence very short so '
    + 'the reply starts quickly.',
});

/**
 * Prefer a hosted voice when a key is present, otherwise use whatever the OS already has.
 * The offline voices sound synthetic; they are here so the example runs before anyone has
 * signed up for anything.
 */
function pickVoice() {
  if (process.env.FISH_AUDIO_API_KEY) {
    return new FishAudioTTS({
      apiKey: process.env.FISH_AUDIO_API_KEY,
      referenceId: process.env.FISH_AUDIO_VOICE || '',
    });
  }
  if (process.env.OPENAI_API_KEY) return new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY });
  if (SayTTS.available) return new SayTTS({ voice: process.env.SAY_VOICE || '' });
  if (EspeakTTS.available) return new EspeakTTS({ voice: process.env.ESPEAK_VOICE || 'cmn' });
  return null;
}

const tts = pickVoice();
if (!tts) {
  console.error('No voice available. Set FISH_AUDIO_API_KEY or OPENAI_API_KEY, or install '
    + 'espeak-ng (macOS has `say` built in).');
  process.exit(1);
}

// The viseme service does not have to be on this machine — it is a small HTTP call, and a
// laptop can borrow one running elsewhere on the network. Unset, the sidecar looks for a
// local one and falls back to the loudness envelope if there is none.
// Fail here rather than three steps later, mid-conversation, where a missing key looks
// like a broken face.
const reach = await host.check();
if (!reach.ok) {
  console.error(`Cannot use the agent: ${reach.detail}`);
  console.error('Set HERMES_URL to your agent, and HERMES_KEY if it needs one.');
  console.error('Hermes keeps its key in ~/.hermes/.env as API_SERVER_KEY.');
  process.exit(1);
}

const port = Number(process.env.PORT || 8730);
const { viseme } = await createEmmaSkinServer({
  host,
  tts,
  port,
  staticDirs: [here, repo],
  ...(process.env.VISEME_URL
    ? { viseme: new OnnxViseme({ url: process.env.VISEME_URL }) }
    : {}),
});

console.log(`EMMA Skin → http://127.0.0.1:${port}`);
console.log(`  agent  ${reach.detail}`);
console.log(`  voice  ${tts.constructor.name}`);
console.log(`  mouth  ${viseme.constructor.name}`);
