/**
 * Give any OpenAI-compatible agent a face.
 *
 * If your agent exposes `/v1/chat/completions` with `stream: true` — Ollama, LM Studio,
 * vLLM, LiteLLM, OpenAI itself, or something you wrote — this is the whole integration.
 * Point it at the URL and run.
 *
 *   AGENT_URL=http://127.0.0.1:11434 AGENT_MODEL=llama3 node examples/agent/serve.js
 *
 * Start here. examples/hermes/ is the same thing with one extra: that agent reports its
 * tool calls on the same stream, so the face can look busy because it is.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createEmmaSkinServer } from '../../packages/server/src/server.js';
import { OnnxViseme } from '../../packages/server/src/viseme.js';
import { OpenAICompatibleHost } from '../../packages/server/src/host.js';
import { SayTTS, EspeakTTS, FishAudioTTS, OpenAITTS } from '../../packages/server/src/tts.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const host = new OpenAICompatibleHost({
  baseUrl: process.env.AGENT_URL || 'http://127.0.0.1:11434',
  apiKey: process.env.AGENT_KEY || '',
  model: process.env.AGENT_MODEL || 'default',
  // Spoken replies are not written replies. Without this, models produce bullet lists and
  // headings, and a TTS engine reads the punctuation out loud.
  systemPrompt: process.env.AGENT_PROMPT
    || 'You are speaking out loud, not writing. Reply in short spoken sentences. '
    + 'No markdown, no lists, no headings, no emoji. Keep the first sentence very short so '
    + 'the reply starts quickly.',
});

/**
 * Prefer a hosted voice when a key is present, otherwise use whatever the OS already has.
 * The offline voices sound synthetic; they are here so the first run costs nothing.
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
  console.error('No voice available. Pick one:');
  console.error('  macOS      already has `say` — nothing to install');
  console.error('  Linux      apt install espeak-ng   (or dnf/pacman)');
  console.error('  any OS     set OPENAI_API_KEY, or FISH_AUDIO_API_KEY');
  process.exit(1);
}

// Fail here rather than mid-conversation, where a wrong URL or a missing key looks like a
// broken face.
const reach = await host.check();
if (!reach.ok) {
  console.error(`Cannot use the agent: ${reach.detail}`);
  console.error('Set AGENT_URL to an OpenAI-compatible endpoint, AGENT_KEY if it needs one,');
  console.error('and AGENT_MODEL to a model it serves (see GET /v1/models).');
  process.exit(1);
}

// HOST is opt-in: the default keeps this on loopback, because the sidecar carries the
// agent's key and checks nobody. Set it to a private address to use the face from a phone.
const port = Number(process.env.PORT || 8730);
const hostname = process.env.HOST || '127.0.0.1';
const { viseme } = await createEmmaSkinServer({
  host,
  tts,
  port,
  hostname,
  staticDirs: [here, repo],
  ...(process.env.VISEME_URL
    ? { viseme: new OnnxViseme({ url: process.env.VISEME_URL }) }
    : {}),
});

console.log(`EMMA Skin → http://${hostname}:${port}`);
console.log(`  agent  ${reach.detail}`);
console.log(`  voice  ${tts.constructor.name}`);
console.log(`  mouth  ${viseme.constructor.name}`);
