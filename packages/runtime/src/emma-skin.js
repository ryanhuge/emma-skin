/**
 * EMMA Skin — a talking face for any agent.
 *
 * Renders a photoreal portrait that lip-syncs to audio. Two layers, and which one is on
 * screen depends only on whether she is speaking:
 *
 *   quiet     a short video clip loops — real blinks, real micro-expression, real breath
 *   speaking  a canvas composites mouth sprites over the still portrait
 *
 * The split exists because neither half can do the other's job. Video carries life that a
 * 2D transform cannot fake, but its mouth says whatever the video model invented. Sprites
 * say the right thing but sit on a rigid face. Each is used where it wins, and the handover
 * is covered by a blur pull because the two layers do not agree on where the head is —
 * measured, in Veo's clips, at 13-19% of drift in head scale across a single take.
 *
 * Lip sync is driven by a viseme curve derived from the very PCM being played, so lips and
 * audio share one clock and cannot drift apart. Nothing here knows about phonemes, text, or
 * which model produced the audio.
 *
 *   const face = new EmmaSkin({ canvas, video, art: '/assets/emma/' });
 *   await face.load();
 *   face.setState('listening');
 *   face.speak({ pcm, sampleRate, visemes, fps });   // one sentence, call as they arrive
 *
 * No dependencies, no build step, no framework.
 */

/** Idle-motion tuning for the still-portrait fallback, in the range the clips actually move. */
const SWAY = { xA: 5, xB: 2, yA: 4, yB: 1.5, breathe: 0.0022, roll: 0.5 };

/**
 * Reshape openness from the viseme model into how far a jaw actually travels.
 *
 * Viseme models normalise against the loudest frame they were calibrated on, which puts
 * ordinary speech near the top of the scale — measured over a real reply at p25 0.39 /
 * median 0.66 / p95 0.95, with 8% of frames above 0.9. Fed in raw, the widest shapes in the
 * library dominate and the mouth hangs open between words. That reads as overacting on a
 * head which is otherwise still.
 *
 * Two knobs, because the ends need opposite treatment: the gamma expands the bottom so gaps
 * between syllables actually close, the gain caps the top. Together they map that measured
 * distribution onto p25 0.08 / median 0.24 / p95 0.49.
 */
const MOUTH_GAMMA = 2.0;
const MOUTH_GAIN = 0.55;

/** How long the blur covers a layer swap, and how far it leads the crossfade. */
const XFADE_LEAD_MS = 70;
const XFADE_HOLD_MS = 260;

export class EmmaSkin {
  /**
   * @param {object}            opts
   * @param {HTMLCanvasElement} opts.canvas  drawn while speaking
   * @param {HTMLVideoElement}  opts.video   looped while quiet; may be omitted
   * @param {string}            opts.art     face pack directory, e.g. '/assets/emma/'
   * @param {object}           [opts.clips]  state -> clip id, e.g. {listening: 'thinking'}
   */
  constructor({ canvas, video = null, art = '/assets/emma/', clips = null }) {
    this.canvas = canvas;
    this.video = video;
    this.art = art.replace(/\/?$/, '/');

    // Which clip plays in which state. `listening` pointing at the thinking take is the
    // face pack's business, not the runtime's — a pack may not ship a listening clip.
    this.clipFor = clips || { idle: 'idle', listening: 'thinking', thinking: 'thinking' };

    this.state = 'idle';
    this.speaking = false;
    this._clipId = null;
    this._xfadeTimer = null;

    this.base = null;
    this.mouthSet = null;
    this.eyeSet = null;
    this.version = '';

    this.ctx = null;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.mouth = { openness: 0, width: 0.3, roundness: 0.2 };

    this.audioCtx = null;
    this._playCursor = 0;
    this._timeline = [];
    this._blinkPhase = 1;
    this._nextBlink = 0;
    this._raf = null;

    this._onResize = () => { if (this.base) this._fit(); };
  }

  // ── loading ────────────────────────────────────────────────────────────────

  /**
   * Fetch the face pack.
   *
   * Manifests are fetched no-cache and every asset URL carries the pack's build stamp:
   * sprite rebuilds keep their filenames while the tiles change size, and a stale tile drawn
   * into a fresh placement box does not look like a caching problem, it looks like a broken
   * composite.
   */
  async load() {
    const [mouthMeta, eyeMeta] = await Promise.all([
      fetch(`${this.art}mouth-sprites.json`, { cache: 'no-cache' }).then((r) => r.json()),
      fetch(`${this.art}eyes.json`, { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    const mv = mouthMeta.version ? `?v=${mouthMeta.version}` : '';
    const ev = eyeMeta.version ? `?v=${eyeMeta.version}` : '';
    this.version = mouthMeta.version || 'unversioned';

    const img = (src) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(`face pack: cannot load ${src}`));
      i.src = src;
    });

    const [base, mouths, eyes] = await Promise.all([
      img(`${this.art}${mouthMeta.base}${mv}`),
      Promise.all(mouthMeta.sprites.map(async (s) => ({ ...s, img: await img(`${this.art}mouth-sprites/${s.file}${mv}`) }))),
      Promise.all(eyeMeta.sprites.map(async (s) => ({ ...s, img: await img(`${this.art}eyes/${s.file}${ev}`) }))),
    ]);

    this.base = base;
    this.mouthSet = { place: mouthMeta.placement, sprites: mouths };
    this.eyeSet = { place: eyeMeta.placement, sprites: eyes };

    this._fit();
    addEventListener('resize', this._onResize);
    this.setState('idle');
    this._raf = requestAnimationFrame((t) => this._loop(t));
    return this;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._xfadeTimer);
    removeEventListener('resize', this._onResize);
    this.audioCtx?.close?.();
  }

  // ── state ──────────────────────────────────────────────────────────────────

  /** 'idle' | 'listening' | 'thinking' — what she does between utterances. */
  setState(state) {
    this.state = state;
    if (!this.video) return;
    const id = this.clipFor[state] || this.clipFor.idle;
    if (id === this._clipId && this.video.src) return;
    this._clipId = id;
    if (!this.video.src.endsWith(`${id}.mp4`)) this.video.src = `${this.art}clips/${id}.mp4`;
    this.video.play().catch(() => {});
  }

  /**
   * Swap layers under cover of a blur pull.
   *
   * The filter gets a head start so both layers are already soft before either changes
   * opacity, and lifts only once the dissolve is done. A straight dissolve shows both heads
   * at once — measured as a plain double exposure, two sets of eyes — because the clips'
   * head pose wanders across a take. 9px is where the ghost stops resolving: held at the
   * worst frame and a 50/50 mix, 6px still showed two sets of eyes and 8px did not.
   *
   * Coming back, the clip is rewound first: clips are generated with the portrait as their
   * first frame, so frame 0 measures ~2.6/255 against the canvas at rest and that direction
   * barely needs covering at all.
   */
  _setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = on;
    const stage = this.canvas.parentElement;
    if (!this.video || !stage) return;

    stage.classList.add('emma-xfade');
    clearTimeout(this._xfadeTimer);
    if (!on) {
      try { this.video.currentTime = 0; } catch { /* seeking is best-effort */ }
      this.video.play().catch(() => {});
    }
    setTimeout(() => stage.classList.toggle('emma-speaking', on), XFADE_LEAD_MS);
    this._xfadeTimer = setTimeout(() => stage.classList.remove('emma-xfade'),
      XFADE_LEAD_MS + XFADE_HOLD_MS);
  }

  // ── speech ─────────────────────────────────────────────────────────────────

  get _ac() {
    return (this.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
  }

  /** Browsers start the audio context suspended; call this from a user gesture. */
  async resume() { await this._ac.resume(); }

  /**
   * Queue one utterance. Call repeatedly as sentences arrive — they butt against each other
   * so speech stays continuous, which is what makes streaming TTS sound unbroken.
   *
   * @param {object} s
   * @param {Int16Array|Float32Array|string} s.pcm  mono samples, or base64 of Int16 LE
   * @param {number} s.sampleRate
   * @param {object} [s.visemes]  {openness[], width[], roundness[]} at s.fps
   * @param {number} [s.fps=30]
   * @returns {number} seconds until this utterance finishes
   */
  speak({ pcm, sampleRate, visemes = null, fps = 30 }) {
    const ac = this._ac;
    const samples = typeof pcm === 'string' ? decodeBase64Pcm(pcm) : pcm;
    const buf = ac.createBuffer(1, samples.length, sampleRate);
    const ch = buf.getChannelData(0);
    if (samples instanceof Float32Array) ch.set(samples);
    else for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;

    // A little lead-in on the first sentence absorbs decode jitter; after that each one
    // starts where the previous ended.
    const start = Math.max(ac.currentTime + 0.06, this._playCursor);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(start);
    this._playCursor = start + buf.duration;

    if (visemes) this._timeline.push({ start, end: this._playCursor, fps, mouth: visemes });
    this._setSpeaking(true);

    const remaining = this._playCursor - ac.currentTime;
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => {
      this._setSpeaking(false);
      this.setState('idle');
      this.onSpeechEnd?.();
    }, remaining * 1000 + 250);
    return remaining;
  }

  /** Drop anything queued and fall silent. */
  stop() {
    this._timeline.length = 0;
    this._playCursor = 0;
    clearTimeout(this._endTimer);
    this._setSpeaking(false);
  }

  _sampleMouth(now) {
    while (this._timeline.length && this._timeline[0].end < now - 0.2) this._timeline.shift();
    for (const seg of this._timeline) {
      if (now < seg.start || now > seg.end) continue;
      const i = Math.min(seg.mouth.openness.length - 1, Math.floor((now - seg.start) * seg.fps));
      return { openness: seg.mouth.openness[i], width: seg.mouth.width[i], roundness: seg.mouth.roundness[i] };
    }
    return null;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  _fit() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.ctx = this.canvas.getContext('2d');
  }

  /** Nearest two shapes on the three mouth axes, weighted by distance. */
  _pickMouth() {
    const { openness: o, width: w, roundness: r } = this.mouth;
    const score = (s) => {
      const a = (s.openness - o) * 1.6, b = (s.width - w) * 0.7, c = (s.roundness - r) * 0.7;
      return a * a + b * b + c * c;
    };
    const [x, y] = [...this.mouthSet.sprites].sort((p, q) => score(p) - score(q));
    const dx = Math.sqrt(score(x)), dy = Math.sqrt(score(y));
    return [[x, dx + dy === 0 ? 1 : dy / (dx + dy)], [y, dx + dy === 0 ? 0 : dx / (dx + dy)]];
  }

  /**
   * Blinks are on a timer, and have to be: audio-driven expression models report eyeBlink
   * at roughly noise level over real speech (measured 0.0001 std). Blinking simply is not
   * predictable from what someone is saying.
   */
  _eyeOpenness(t) {
    if (t > this._nextBlink) {
      this._blinkPhase = 0;
      this._nextBlink = t + 2200 + Math.random() * 3600;
    }
    if (this._blinkPhase < 1) this._blinkPhase = Math.min(1, this._blinkPhase + 0.13);
    const p = this._blinkPhase;
    // Fast close, slower open — a linear blink reads as a twitch.
    return p < 0.35 ? 1 - p / 0.35 : (p - 0.35) / 0.65;
  }

  _pickEye(open) {
    const [a, b] = [...this.eyeSet.sprites].sort(
      (p, q) => Math.abs(p.openness - open) - Math.abs(q.openness - open));
    const da = Math.abs(a.openness - open), db = Math.abs(b.openness - open);
    return [[a, da + db === 0 ? 1 : db / (da + db)], [b, da + db === 0 ? 0 : da / (da + db)]];
  }

  _draw(t) {
    const ctx = this.ctx;
    if (!ctx || !this.base) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Cover-fit biased upward so the face sits in the upper half — must match the CSS
    // object-position on the video, or the two layers land differently.
    const scale = Math.max(W / this.base.width, H / this.base.height);
    const dw = this.base.width * scale, dh = this.base.height * scale;
    const bx = (W - dw) / 2, by = (H - dh) * 0.22;

    // Two sine pairs at incommensurable periods so the loop never reads as a loop.
    const swayX = Math.sin(t / 3100) * SWAY.xA + Math.sin(t / 1700) * SWAY.xB;
    const swayY = Math.cos(t / 2600) * SWAY.yA + Math.sin(t / 900) * SWAY.yB;
    const breathe = Math.sin(t / 3400) * SWAY.breathe;
    const roll = Math.sin(t / 4300) * SWAY.roll;

    ctx.save();
    ctx.translate(W / 2 + swayX * this.dpr, H / 2 + swayY * this.dpr);
    ctx.rotate((roll * Math.PI) / 180);
    ctx.scale(1 + breathe, 1 + breathe);
    ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(this.base, bx, by, dw, dh);

    /**
     * Nearest sprite solid, runner-up faded over it.
     *
     * Painting both at partial alpha is the obvious reading of a two-frame blend and it is
     * wrong: neither fully covers, so the base portrait shows through both — and the base
     * has her mouth closed. The result is an open mouth with a closed one ghosting under it.
     */
    const paint = (picks, place) => {
      const put = (sprite, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite.img, bx + place.x * scale, by + place.y * scale,
          place.w * scale, place.h * scale);
        ctx.globalAlpha = 1;
      };
      put(picks[0][0], 1);
      if (picks[1] && picks[1][1] > 0.01) put(picks[1][0], picks[1][1]);
    };

    paint(this._pickEye(this._eyeOpenness(t)), this.eyeSet.place);
    paint(this._pickMouth(), this.mouthSet.place);
    ctx.restore();
  }

  _loop(t) {
    const target = this.speaking && this.audioCtx
      ? this._sampleMouth(this.audioCtx.currentTime)
      : null;
    const want = target
      ? {
        openness: MOUTH_GAIN * Math.pow(Math.max(0, Math.min(1, target.openness)), MOUTH_GAMMA),
        width: target.width,
        roundness: target.roundness,
      }
      : { openness: 0, width: 0.3, roundness: 0.2 };

    // Ease toward the target: viseme data is 30fps and the canvas runs at 60, so stepping
    // straight to each value would visibly stair-step.
    const k = target ? 0.45 : 0.2;
    for (const key of ['openness', 'width', 'roundness']) {
      this.mouth[key] += (want[key] - this.mouth[key]) * k;
    }

    this._draw(t);
    this._raf = requestAnimationFrame((next) => this._loop(next));
  }
}

function decodeBase64Pcm(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export default EmmaSkin;
