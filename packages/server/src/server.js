/**
 * The sidecar: one SSE endpoint that turns a question into a talking face.
 *
 * It exists for two reasons. Credentials — the agent's API key has no business in a
 * browser. And ordering — sentences are synthesized concurrently but must be emitted in
 * order, or she says the second half of the answer first.
 *
 *   POST /api/converse  {"text": "..."} → SSE
 *     event: state      {"state":"thinking"}
 *     event: transcript {"role":"assistant","text":"..."}   as each sentence is decided
 *     event: sentence   {"text","audio":{"pcm":<b64>,"sampleRate"},"visemes",...}
 *     event: done       {}
 *
 * The client feeds each `sentence` straight into face.speak(). Nothing else is needed.
 */

import { createServer } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { SentenceSplitter } from './sentences.js';
import { autoViseme } from './viseme.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};

/**
 * @param {object}    opts
 * @param {AgentHost} opts.host        the agent (see host.js)
 * @param {object}   [opts.tts]        anything with synthesize(text) -> {pcm, sampleRate}
 * @param {object}   [opts.viseme]     defaults to the model if running, envelope if not
 * @param {string[]} [opts.staticDirs] directories to serve, first match wins
 * @param {number}   [opts.port=8730]
 * @param {string}   [opts.hostname='127.0.0.1']  bind address
 */
export async function createEmmaSkinServer(opts) {
  const { host, tts, staticDirs = [], port = 8730, hostname = '127.0.0.1' } = opts;
  if (!host) throw new Error('createEmmaSkinServer needs a host');
  const speak = opts.tts ?? null;
  const synth = host.synthesize?.bind(host) ?? speak?.synthesize?.bind(speak);
  if (!synth) throw new Error('no TTS: give the host a synthesize(), or pass opts.tts');

  const viseme = opts.viseme ?? await autoViseme();
  const roots = staticDirs.map((d) => resolve(d));

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/converse') {
        return await converse({ req, res, host, synth, viseme });
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        return json(res, 200, { status: 'ok', viseme: viseme.constructor.name });
      }
      return await serveStatic(req, res, roots);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
      else res.end();
    }
  });

  // Loopback unless asked otherwise. This sidecar proxies your agent and holds its API key,
  // and it authenticates nobody — listening on every interface by default would put the
  // agent on whatever network the machine happens to join. Pass hostname explicitly (a
  // tailnet address, say) when another device genuinely needs to reach it.
  await new Promise((r) => server.listen(port, hostname, r));
  return { server, port, hostname, viseme };
}

async function converse({ req, res, host, synth, viseme }) {
  const body = await readJson(req);
  const text = String(body?.text || '').trim();
  const history = Array.isArray(body?.history) ? body.history : [];
  if (!text) return json(res, 400, { error: 'text is required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  // Hosts that report their own tool activity drive the thinking state directly; the rest
  // simply stay in it until the first sentence is ready.
  host.onActivity?.((a) => send('state', a));
  send('state', { state: 'thinking' });

  const splitter = new SentenceSplitter();

  /**
   * Synthesis runs concurrently but playback must not. Each sentence chains its emission
   * onto the previous one, so a short sentence finishing early waits its turn instead of
   * jumping the queue.
   */
  let chain = Promise.resolve();
  let index = 0;
  const pending = [];

  const enqueue = (sentence) => {
    const i = index++;
    send('transcript', { role: 'assistant', text: sentence, index: i });
    const work = (async () => {
      const { pcm, sampleRate } = await synth(sentence);
      let visemes = null;
      try {
        visemes = await viseme.extract(pcm, sampleRate);
      } catch (err) {
        // A missing mouth curve is survivable — she still speaks, the lips just rest.
        console.warn(`[emma-skin] viseme extraction failed: ${err.message}`);
      }
      return { pcm, sampleRate, visemes };
    })();
    pending.push(work);
    chain = chain.then(async () => {
      const { pcm, sampleRate, visemes } = await work;
      send('sentence', {
        index: i,
        text: sentence,
        audio: { pcm: Buffer.from(pcm).toString('base64'), sampleRate },
        visemes: visemes?.mouth ?? null,
        fps: visemes?.fps ?? 30,
      });
    }).catch((err) => send('error', { message: String(err.message || err), index: i }));
  };

  try {
    for await (const delta of host.chat(text, { signal: abort.signal, history })) {
      for (const s of splitter.push(delta)) enqueue(s);
    }
    for (const s of splitter.flush()) enqueue(s);
    await Promise.allSettled(pending);
    await chain;
    send('done', {});
  } catch (err) {
    send('error', { message: String(err.message || err) });
  } finally {
    res.end();
  }
}

/**
 * Dotfiles are never served.
 *
 * The examples hand this the repository root so the runtime and the face pack resolve by
 * path, which also means `/.git/config`, `/.git/HEAD` and the rest of the object store are
 * a plain GET away — the full source and history, including whatever remote it was cloned
 * from. Harmless on loopback, an unattended file server the moment anyone sets HOST to
 * reach the face from a phone.
 */
const HIDDEN = /(^|[/\\])\./;

async function serveStatic(req, res, roots) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  if (HIDDEN.test(rel)) return void res.writeHead(404).end('not found');

  for (const root of roots) {
    const file = join(root, rel);
    // Compare against root + separator: a bare startsWith would also accept a sibling
    // directory whose name merely begins with the root's, and resolve() does not follow
    // symlinks, so a link inside the tree could still point out of it.
    const abs = resolve(file);
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    try {
      const stat = await lstat(abs);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const buf = await readFile(abs);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      return res.end(buf);
    } catch { /* try the next root */ }
  }
  res.writeHead(404).end('not found');
}

function readJson(req) {
  return new Promise((resolve_, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => { try { resolve_(JSON.parse(raw || '{}')); } catch { resolve_(null); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
