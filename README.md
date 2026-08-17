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
node examples/hermes/serve.js          # add HERMES_URL / HERMES_KEY as needed
```

It checks the agent before it starts listening, so a wrong URL or a missing key fails
immediately and says which:

```
Cannot use the agent: agent rejected the API key (401)
Set HERMES_URL to your agent, and HERMES_KEY if it needs one.
Hermes keeps its key in ~/.hermes/.env as API_SERVER_KEY.
```

A good start looks like this:

```
[emma-skin] viseme service not reachable — falling back to the loudness envelope…
EMMA Skin → http://127.0.0.1:8730
  agent  http://127.0.0.1:8642 (hermes-agent)
  voice  SayTTS
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
`HOST=100.x.y.z node examples/hermes/serve.js` — and understand that anything which can
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

A clean `git clone` on macOS 26.5 (Apple Silicon, Node 22) against Hermes 0.20, following
only the steps above: agent reachable, `say` voice, loudness fallback, two spoken sentences,
mouth moving, returning to the idle clip. Linux is exercised in development but has not been
through the same clean-room run.

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
