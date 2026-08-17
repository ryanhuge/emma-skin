/**
 * The smallest thing that works: one OpenAI API key, nothing else.
 *
 *   OPENAI_API_KEY=sk-... node examples/openai/serve.js
 *
 * No local agent, no local voice, no model download. The key pays for the words and the
 * voice; the face and the lip sync run on your machine and cost nothing.
 *
 * Mouth shapes come from the loudness envelope unless you install the viseme model — see
 * packages/viseme/README.md. That is the only part of this example that is a compromise.
 *
 * Anything that speaks the same dialect works too, by pointing OPENAI_BASE_URL elsewhere:
 * Groq, Together, OpenRouter, a local Ollama. See examples/agent/ for that shape.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createEmmaSkinServer } from '../../packages/server/src/server.js';
import { OnnxViseme } from '../../packages/server/src/viseme.js';
import { OpenAICompatibleHost } from '../../packages/server/src/host.js';
import { OpenAITTS } from '../../packages/server/src/tts.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Set OPENAI_API_KEY.');
  console.error('  OPENAI_API_KEY=sk-... node examples/openai/serve.js');
  console.error('');
  console.error('Optional: OPENAI_MODEL (default gpt-4o-mini), OPENAI_VOICE (default nova),');
  console.error('OPENAI_BASE_URL to use a compatible provider instead.');
  process.exit(1);
}

const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';

const host = new OpenAICompatibleHost({
  baseUrl,
  apiKey,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  // Spoken replies are not written replies. Without this the model produces bullet lists
  // and headings, and a TTS engine reads the punctuation out loud.
  systemPrompt: process.env.AGENT_PROMPT
    || 'You are speaking out loud, not writing. Reply in short spoken sentences. '
    + 'No markdown, no lists, no headings, no emoji. Keep the first sentence very short so '
    + 'the reply starts quickly.',
});

const tts = new OpenAITTS({
  baseUrl,
  apiKey,
  model: process.env.OPENAI_TTS_MODEL || 'tts-1',
  voice: process.env.OPENAI_VOICE || 'nova',
});

// Catch a bad key here rather than mid-conversation, where it looks like a broken face.
const reach = await host.check();
if (!reach.ok) {
  console.error(`Cannot use the agent: ${reach.detail}`);
  process.exit(1);
}

// Loopback by default: this holds your API key and authenticates nobody. Set HOST to a
// private address to reach the face from a phone, and know what that means.
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
console.log(`  voice  OpenAI ${tts.voice}`);
console.log(`  mouth  ${viseme.constructor.name}`);
