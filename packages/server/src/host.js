/**
 * What an agent has to provide in order to get a face.
 *
 * The answer is: text, and nothing else. Mouth shapes are derived from the audio, not from
 * the words — so a host never supplies phonemes, timings, emotions or a viseme track. It
 * streams text deltas the way it already does for a chat UI, and EMMA Skin does the rest.
 *
 * Everything below `chat` is optional. Implement `synthesize` to use your own voice;
 * implement `onActivity` if your agent knows when it is working, so the face can look like
 * it is thinking rather than guessing from silence.
 *
 * ── The one hard constraint ────────────────────────────────────────────────────
 * `synthesize` must return PCM samples, not "play this URL". Lips and audio have to share
 * a single clock or they drift, and the only way to guarantee that is to derive the mouth
 * curve from the very samples that will be played. A host whose TTS can only play audio
 * itself cannot be lip-synced by anything, including this.
 */

/**
 * @typedef  {object} Utterance
 * @property {Buffer|Int16Array} pcm         mono, 16-bit signed
 * @property {number}            sampleRate
 */

export class AgentHost {
  /**
   * Stream a reply as text deltas.
   * @param {string} userText
   * @param {{signal?: AbortSignal, history?: Array}} [opts]
   * @returns {AsyncIterable<string>}
   */
  // eslint-disable-next-line require-yield
  async *chat(userText, opts) {
    throw new Error('AgentHost.chat() must be implemented');
  }

  /*
   * Two more methods are part of this interface, and are deliberately NOT declared here:
   *
   *   synthesize(sentence) -> Promise<Utterance>
   *       Turn one sentence into audio. Omit to use the configured TTS.
   *
   *   onActivity(cb)
   *       Register a callback for {state, detail} as the agent works, so the face can look
   *       busy because it is. Omit if the agent has nothing to report.
   *
   * Declaring them as class fields (`synthesize = undefined`) is the obvious way to
   * document an optional method and it silently breaks every subclass: class fields are
   * assigned on the instance at construction, which shadows the prototype method a subclass
   * defined. `host.onActivity?.()` then reads undefined and does nothing — no error, the
   * feature simply never fires. Callers must feature-detect, which is what `?.` is for.
   */
}

/**
 * Works with anything that speaks the OpenAI chat-completions dialect: Hermes, Emma,
 * Ollama, vLLM, OpenAI itself. This is the adapter most hosts need, and usually the only
 * one — pointing it at a base URL is the whole integration.
 */
export class OpenAICompatibleHost extends AgentHost {
  /**
   * @param {object}  opts
   * @param {string}  opts.baseUrl   e.g. 'http://127.0.0.1:8642'
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model]
   * @param {string} [opts.systemPrompt]
   */
  constructor({ baseUrl, apiKey = '', model = 'default', systemPrompt = '' }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Check the agent answers before anyone tries to talk to it.
   *
   * Without this the first failure surfaces mid-conversation, as an error event after the
   * face has already gone to thinking — which reads as "the face is broken" when the real
   * answer is a missing API key. Startup is the honest place to find out.
   *
   * @returns {Promise<{ok: boolean, detail: string}>}
   */
  async check() {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      // Auth is worth failing on: a rejected key will reject every turn too.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `agent rejected the API key (${res.status})` };
      }
      // /v1/models is optional in practice — plenty of servers implement only the chat
      // endpoint. Refusing to start on a 404 rejects agents that work perfectly well, which
      // is precisely the kind of check that makes software feel broken to everyone whose
      // setup differs from the author's.
      if (res.status === 404) {
        return { ok: true, detail: `${this.baseUrl} (${this.model}, /v1/models not offered)` };
      }
      if (!res.ok) return { ok: false, detail: `agent returned ${res.status}` };
      return { ok: true, detail: `${this.baseUrl} (${this.model})` };
    } catch (err) {
      return { ok: false, detail: `cannot reach ${this.baseUrl}: ${err.message}` };
    }
  }

  async *chat(userText, { signal, history = [] } = {}) {
    const messages = [
      ...(this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : []),
      ...history,
      { role: 'user', content: userText },
    ];

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
    });
    if (!res.ok) {
      throw new Error(`agent ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    yield* this._readSse(res);
  }

  /**
   * Read an SSE stream, yielding content deltas.
   *
   * Non-`data:` lines are handed to _onEvent rather than ignored, because some agents
   * interleave their own event types — Hermes emits `event: hermes.tool.progress` while it
   * works, which is exactly the signal the face wants.
   */
  async *_readSse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventName = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);

        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) { if (!line) eventName = ''; continue; }

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        if (eventName && eventName !== 'message') {
          this._onEvent?.(eventName, json);
          continue;
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  }
}

/**
 * Hermes speaks the OpenAI dialect, so the adapter is the generic one plus one detail:
 * Hermes announces its tool calls on the same stream.
 *
 *   event: hermes.tool.progress
 *   data: {"tool": "mem0_search", "emoji": "⚡"}
 *
 * Forwarding that to the face is the difference between a face that looks thoughtful
 * because it is working, and one that looks thoughtful because a timer said so.
 */
export class HermesHost extends OpenAICompatibleHost {
  constructor(opts) {
    super({ model: 'hermes-agent', ...opts });
    this._activityCb = null;
    this._onEvent = (name, data) => {
      if (name !== 'hermes.tool.progress' || !this._activityCb) return;
      this._activityCb({ state: 'thinking', detail: data?.tool || '' });
    };
  }

  onActivity(cb) { this._activityCb = cb; }
}
