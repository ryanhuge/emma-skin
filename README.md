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

## Install

There is no build step and nothing to `npm install` — the runtime has no dependencies and
the server uses only Node built-ins. The face is in the repository; you do not generate
anything.

**You need:** Node 18+, an agent with an OpenAI-compatible streaming endpoint, and a voice.
macOS already has one (`say`); on Linux, `apt install espeak-ng`. Both sound synthetic —
they are there so the first run costs nothing.

```bash
git clone <REPO_URL> emma-skin
cd emma-skin
```

Then pick whichever describes you. All three serve the same face at the same address.

**A. One API key, nothing local.** The smallest thing that works — the key pays for both the
words and the voice.

```bash
OPENAI_API_KEY=sk-... node examples/openai/serve.js
```

Set `OPENAI_BASE_URL` to use a compatible provider instead (Groq, Together, OpenRouter).

**B. An agent you already run.** Anything that serves `/v1/chat/completions` with
`stream: true` — Ollama, LM Studio, vLLM, LiteLLM, your own.

```bash
AGENT_URL=http://127.0.0.1:11434 AGENT_MODEL=llama3 node examples/agent/serve.js
```

The voice comes from the OS here: macOS already has `say`; on Linux run
`apt install espeak-ng`. Set `OPENAI_API_KEY` or `FISH_AUDIO_API_KEY` for a better one.

**C. Hermes.** Same as B, plus one thing the generic adapter cannot know: Hermes announces
its tool calls on the same stream, so the face looks like it is working *because it is*,
rather than on a timer.

```bash
export HERMES_KEY=$(grep '^API_SERVER_KEY=' ~/.hermes/.env | cut -d= -f2-)
HERMES_URL=http://127.0.0.1:8642 node examples/hermes/serve.js
```

Hermes needs its key even from localhost, and keeps it in `~/.hermes/.env`. On a Mac that is
the whole install: Node is already there if Hermes runs, and `say` supplies the voice, so
nothing is downloaded and no account is needed.

It checks the agent before it starts listening, so a wrong URL or a missing key fails
immediately and says which:

```
Cannot use the agent: agent rejected the API key (401)
Set AGENT_URL to an OpenAI-compatible endpoint, AGENT_KEY if it needs one,
and AGENT_MODEL to a model it serves (see GET /v1/models).
```

A good start looks like this:

```
[emma-skin] viseme service not reachable — falling back to the loudness envelope…
EMMA Skin → http://127.0.0.1:8730
  agent  https://api.openai.com (gpt-4o-mini)
  voice  OpenAI nova
  mouth  EnergyViseme
```

That warning is expected on a first run: the mouth model is a separate 400MB download, so
until you install it the mouth follows loudness instead. It moves, and it is obviously not
real lip sync. See [packages/viseme/README.md](packages/viseme/README.md) to upgrade — the
service can also run on another machine (`VISEME_URL`), so a laptop can borrow a desktop's.

Then open **http://127.0.0.1:8730** and hold the microphone button. No microphone, or a
browser without speech recognition? Drive a turn from the console instead:

```js
converse('introduce yourself in one sentence')
```

The server listens on loopback only: it holds your agent's API key and authenticates
nobody. To reach it from a phone, bind it to a private address explicitly —
`HOST=192.168.1.20 node examples/agent/serve.js` — and understand that anything which can
reach that address can talk to your agent.

**Even less than that:** no agent, no server, no keys — a recorded clip and its
pre-computed mouth curve, to see the renderer on its own.

```bash
python3 -m http.server 8899
open http://127.0.0.1:8899/examples/static/
```

**A better voice:** set `FISH_AUDIO_API_KEY` or `OPENAI_API_KEY` and it will be preferred
over the built-in one. Neither account is bundled; see [NOTICE](NOTICE).

### Verified on

Each row is a fresh `git clone` following only the steps above — no shared state between
them, and deliberately different combinations rather than the same one twice.

| OS | agent | voice | mouth | result |
|---|---|---|---|---|
| macOS 26.5, Node 22 | Hermes 0.20 (local) | `say` | loudness fallback | ✅ 2 sentences, mouth moving, returns to idle |
| Linux, Node 22 | Groq (`gpt-oss-20b`) | espeak-ng | ONNX model | ✅ 2 sentences, 59 + 69 mouth frames |
| Linux, Node 22 | DeepSeek via an OpenAI-compatible gateway | espeak-ng | ONNX model | ✅ 2 sentences, 68 + 194 frames |
| any | OpenAI (`examples/openai/`) | OpenAI TTS | — | ⚠️ **auth only** |

The last row is honest about what was not done: the test key had no credits, so
`api.openai.com` returned 429 before either the chat or the speech call did any work. The
chat path is the same `OpenAICompatibleHost` the two verified rows exercise, but
`OpenAITTS` — the `/v1/audio/speech` call — has never actually run. If you use that example
and it breaks, that is why.

A reasoning model works incidentally: DeepSeek interleaves `reasoning_content` in the same
stream, and since only `delta.content` is read, the thinking is not spoken aloud.

## Architecture

Three processes. The browser draws, the sidecar orchestrates, the viseme service does one
numerical job and can live on another machine or not exist at all.

```
  browser                     sidecar (node)                  your stuff
  ─────────────────────────   ─────────────────────────────   ──────────────────
  speech recognition
    │ text
    └──── POST /api/converse ──▶ AgentHost.chat() ──────────────▶ agent (streaming)
                                      │ text deltas   ◀──────────
                                 SentenceSplitter
                                      │ one sentence at a time
                                 TTS.synthesize() ──────────────▶ voice (say / API)
                                      │ PCM          ◀──────────
                                 viseme.extract() ──────────────▶ viseme service
                                      │ mouth curve  ◀──────────    (or fallback)
    ◀──── SSE: sentence ──────────────┘
    │
  EmmaSkin.speak({pcm, visemes})
    ├─ schedules the audio on the AudioContext timeline
    └─ samples the curve against that same clock, 60fps
```

**The clock is the whole design.** The mouth curve is computed from the exact samples that
will be played, and both are scheduled on one AudioContext timeline — so lips and audio
cannot drift, whatever the network does between them. Every constraint in the interface
follows from this, including the one about `synthesize` returning PCM.

**Sentences, not replies.** The splitter emits as soon as a clause closes, and the first one
is allowed to break early on a comma. Synthesis for sentence *n+1* runs while *n* is still
playing, so only the first sentence costs latency. They are emitted strictly in order,
because concurrent synthesis finishing out of order would otherwise have her say the second
half of the answer first — that ordering is the sidecar's main job besides holding the key.

**Failure is partial.** No viseme service means a loudness envelope instead of a curve. A
failed extraction means that one sentence plays with a resting mouth. A dead agent is caught
at startup. Nothing here takes the face down with it.

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
