#!/usr/bin/env node
/**
 * Post-process Veo clips into the loops the avatar plays.
 *
 * Two fixes, both free and local — no regeneration:
 *
 *   Letterbox. Veo only offers 16:9 and 9:16, and Emma's portrait is 2:3, so every clip
 *   comes back with black bars. They are detected rather than assumed, because the bar
 *   height depends on how Veo fit the source.
 *
 *   Looping. A clip whose first and last frame differ visibly ticks on every repeat
 *   (measured 5.7-7.0 mean absolute difference on the Veo takes). Playing it forward then
 *   reversed makes the seam exact by construction, and doubles the apparent length of an
 *   8s render for free. The cost is that motion reverses mid-loop — fine for breathing and
 *   blinking, which is all these idle states contain.
 *
 *   node tools/prepare-clips.mjs <clip.mp4> [...]
 *   node tools/prepare-clips.mjs --all
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIP_DIR = process.env.CLIP_DIR || path.join(ROOT, 'clips-raw');
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'assets/emma/clips');

// Per-clip trims, in seconds, for takes that are good until they aren't. Veo tends to add
// a beat of extra business at the very end; cutting it costs nothing, whereas regenerating
// is $0.80 a go and may land somewhere else entirely. listening stays silent through 6.4s
// and then starts to open her mouth, which is wrong for a listening state.
// Per-clip trims, for takes that are good until they are not. A video model tends to add
// a beat of business at the end; cutting it costs nothing, whereas regenerating costs money
// and may land somewhere else entirely. Keyed by clip id.
const TRIM = {};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** Ask ffmpeg where the real picture is, rather than assuming the bar height. */
function detectCrop(file) {
  // cropdetect reports on stderr, and execFileSync hands back stdout — hence spawnSync.
  const r = spawnSync('ffmpeg',
    ['-v', 'info', '-i', file, '-vf', 'cropdetect=24:2:0', '-frames:v', '60', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stderr || ''}${r.stdout || ''}`;
  const matches = [...out.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  // Last detection has seen the most frames.
  const [, w, h, x, y] = matches[matches.length - 1];
  return { w: +w, h: +h, x: +x, y: +y };
}

function prepare(file) {
  const id = path.basename(file, '.mp4');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const crop = detectCrop(file);
  const probe = JSON.parse(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file]));
  const { width, height } = probe.streams[0];

  /**
   * Crop, mirror and join in a single encode.
   *
   * The obvious way to write this is three ffmpeg runs — crop to a file, reverse that file,
   * concat the two — and it costs a generation of lossy compression at each step. The
   * forward half came out of the old version twice-compressed and the reversed half three
   * times. Measured against a lossless reference of the same edit: 43.34 dB for the
   * three-pass version, 44.17 dB for this one.
   *
   * On this material (soft portrait, flat light, dark background) that difference is not
   * visible, so the clips already built were left alone. It is fixed here because the
   * script is the part other people copy, and three encodes is not the thing to teach.
   *
   * `reverse` buffers the whole stream in memory, which is why these clips are short: at
   * 720x1052 an 8-second take is a couple of hundred megabytes of frames. A minute-long
   * source would need splitting first.
   */
  const chain = [];
  if (crop && (crop.w !== width || crop.h !== height)) {
    chain.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  }
  const graph = `[0:v]${chain.length ? `${chain.join(',')},` : ''}split[a][b];`
    + '[b]reverse[r];[a][r]concat=n=2:v=1[o]';

  // Trim goes *before* -i so it limits what is read. As an output option it would cut the
  // finished ping-pong instead, halving the loop — which is exactly what happened when this
  // was first collapsed into one pass, and it is invisible unless you check the duration.
  //
  // Audio is dropped: Veo generates a soundtrack we never play, and the avatar's audio
  // comes from the TTS pipeline.
  const trim = TRIM[id] ? ['-t', String(TRIM[id])] : [];
  const out = path.join(OUT_DIR, `${id}.mp4`);
  sh('ffmpeg', ['-v', 'error', ...trim, '-i', file,
    '-filter_complex', graph, '-map', '[o]',
    '-an', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out, '-y']);

  const after = JSON.parse(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,duration', '-of', 'json', out]));
  const s = after.streams[0];
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`  ${id.padEnd(18)} ${width}x${height} → ${s.width}x${s.height}  ` +
    `${(+s.duration).toFixed(1)}s (ping-pong)  ${kb}KB` +
    (crop && crop.h !== height ? `  [裁掉 ${height - crop.h}px 黑邊]` : '  [無黑邊]') +
    (TRIM[id] ? `  [截至 ${TRIM[id]}s]` : ''));
  return out;
}

const args = process.argv.slice(2);
const files = args.includes('--all') || !args.length
  ? fs.readdirSync(CLIP_DIR).filter((f) => f.endsWith('.mp4')).map((f) => path.join(CLIP_DIR, f))
  : args;

console.log('後製（裁黑邊 + ping-pong 循環 + 去音軌）:');
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`  ${path.basename(f)} (找不到)`); continue; }
  try { prepare(f); } catch (e) { console.log(`  ${path.basename(f)} ✗ ${e.message.slice(0, 120)}`); }
}
console.log(`\n→ ${OUT_DIR}`);
