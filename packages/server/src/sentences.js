/**
 * Split a streaming reply into speakable sentences, as early as possible.
 *
 * Sentence-at-a-time is what makes a spoken reply feel responsive. Measured against a
 * commercial TTS API, time-to-first-byte is roughly flat (~200ms) while generation runs a
 * few times faster than realtime — so a short opening sentence gets sound out quickly and
 * every later sentence is ready well before the previous one finishes playing. Waiting for
 * the whole reply instead means waiting for the whole reply.
 */

/** Terminators that always close a sentence. CJK and Latin punctuation both. */
const HARD_STOP = /[。！？!?\n]/;
/** Softer breaks, accepted only for the opening sentence so the first audio starts sooner. */
const SOFT_STOP = /[，,、；;：:]/;
/** Past this, split at the next break of any kind rather than let one TTS call balloon. */
const MAX_SENTENCE_CHARS = 40;

/**
 * Strip markup that must never be spoken.
 *
 * Models emit **bold**, bullet lists and backticks even when told not to, and a TTS engine
 * will happily read the asterisks out loud.
 */
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*\-+]\s+/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Incremental splitter. Feed it deltas; it returns whichever complete sentences are now
 * available and keeps the remainder buffered. Call flush() at end of stream for the tail.
 */
export class SentenceSplitter {
  constructor() {
    this._buffer = '';
    this._emitted = 0;
  }

  push(delta) {
    this._buffer += delta || '';
    const out = [];
    for (;;) {
      const idx = this._findBreak();
      if (idx < 0) break;
      const piece = cleanForSpeech(this._buffer.slice(0, idx + 1));
      this._buffer = this._buffer.slice(idx + 1);
      if (piece) {
        out.push(piece);
        this._emitted++;
      }
    }
    return out;
  }

  flush() {
    const piece = cleanForSpeech(this._buffer);
    this._buffer = '';
    if (piece) this._emitted++;
    return piece ? [piece] : [];
  }

  _findBreak() {
    // The opening sentence may break on a comma: shaving it down to a few words gets sound
    // out in a fraction of the time it takes to wait for a full clause.
    const allowSoft = this._emitted === 0;
    for (let i = 0; i < this._buffer.length; i++) {
      const ch = this._buffer[i];
      if (HARD_STOP.test(ch)) return i;
      if (allowSoft && i >= 3 && SOFT_STOP.test(ch)) return i;
      if (i >= MAX_SENTENCE_CHARS && SOFT_STOP.test(ch)) return i;
    }
    return -1;
  }
}
