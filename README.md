# EMMA Skin

A talking face for any agent. Photoreal, lip-synced to speech, and it does not care which
model produced the words.

Give it a stream of text. It handles the voice, the mouth shapes and the rendering.

```js
const face = new EmmaSkin({ canvas, video, art: '/assets/emma/' });
await face.load();
face.setState('listening');
face.speak({ pcm, sampleRate, visemes, fps });
```

## What an agent has to provide

Text deltas. That is the whole interface.

Mouth shapes are derived from the audio, not from the words, so a host never supplies
phonemes, timings, emotions or a viseme track — it streams text the way it already does for
a chat UI.

```js
class MyAgent extends AgentHost {
  async *chat(userText, { signal }) {
    yield* myStreamingLlm(userText, signal);   // required
  }
  async synthesize(sentence) { /* optional: use your own voice */ }
  onActivity(cb) { /* optional: say when you are working */ }
}
```

Anything that speaks the OpenAI chat-completions dialect needs no adapter at all:

```js
new OpenAICompatibleHost({ baseUrl: 'http://127.0.0.1:11434', model: 'llama3' })
```

### The one hard constraint

If you supply your own TTS, `synthesize` must return **PCM samples**, not "play this URL".
Lips and audio have to share a single clock or they drift, and the only way to guarantee
that is to compute the mouth curve from the very samples that will be played. A TTS that
can only play audio itself cannot be lip-synced by anything, including this.

## Try it

**No agent, no server, no keys** — a recorded clip and its pre-computed mouth curve:

```bash
python3 -m http.server 8899
open http://127.0.0.1:8899/examples/static/
```

**With a real agent** (Hermes here; any OpenAI-compatible endpoint works):

```bash
HERMES_URL=http://127.0.0.1:8642 node examples/hermes/serve.js
```

On macOS this needs no API key — the built-in `say` voice is used. On Linux, install
`espeak-ng`. Both sound synthetic; they exist so the first run is free. Set
`FISH_AUDIO_API_KEY` or `OPENAI_API_KEY` for a real voice.

## How it works

Two layers, and which is on screen depends only on whether she is speaking.

| | while quiet | while speaking |
|---|---|---|
| what is shown | a looping video clip | a canvas compositing mouth sprites onto a still portrait |
| where the life comes from | real blinks, real micro-expression, real breath | the mouth, driven by the audio |

Neither half can do the other's job. Video carries life that a 2D transform cannot fake,
but its mouth says whatever the video model invented. Sprites say the right thing but sit on
a rigid face. The handover between them is covered by a brief blur, because the two layers
do not agree on where the head is — video models drift 13–19% in head scale across a single
take, and a straight dissolve shows both heads at once.

Everything measured along the way — why the mouth region has to include the jaw, why the
sprite library is generated from a head crop rather than the full portrait, why the openness
curve needs reshaping — is written up in [docs/face-packs.md](docs/face-packs.md).

## Packages

| | |
|---|---|
| `packages/runtime` | the browser renderer. One file, no dependencies, no build step |
| `packages/server` | Node sidecar: holds credentials, orchestrates TTS and mouth curves |
| `packages/viseme` | audio → mouth curve (Python + ONNX, CPU). Optional — there is a zero-install fallback |
| `assets/emma` | the bundled face: 8 mouth shapes, 3 eye shapes, 5 idle clips |

The sidecar exists for two reasons: your agent's API key has no business in a browser, and
sentences synthesized concurrently must still be *emitted* in order, or she says the second
half of the answer first.

## Face packs

The bundled face (Emma) is ready to use — clone and run, nothing to generate. Building a
face pack from your own portrait is a separate, slower path documented in
[docs/face-packs.md](docs/face-packs.md); it needs a local image-editing model.

## Licence and attribution

Apache 2.0. See [NOTICE](NOTICE) for the components this bundles and their terms —
everything shipped here is Apache 2.0, including the model weights the viseme service uses
and the models the face was generated with. Hosted voices (Fish Audio, OpenAI) are your own
account's business, not this project's.

The idle clips were generated with Google Veo 3.1. Google does not claim ownership of
generated output and permits commercial use and redistribution.
