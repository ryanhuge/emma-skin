#!/usr/bin/env python3
"""
Viseme service — audio → ARKit blendshapes → 2D mouth parameters.

Runs the wav2arkit ONNX model (wav2vec2 encoder + LAM_audio2exp decoder) on CPU.
Measured on this box: ~27x realtime, ~72ms per 2s of audio.

Why a Python sidecar instead of onnxruntime-node: Emma has a history of native
module ABI crash-loops across Node versions (better-sqlite3; see the ExecStartPre
guard on open-design.service). Python's onnxruntime is already installed and this
keeps the native dependency out of Emma's process entirely.

Why whole-utterance inference: audio is synthesized sentence-by-sentence by TTS,
so every request is a complete self-contained segment. That sidesteps wav2vec2's
receptive-field boundary artifacts — no overlap-and-stitch needed.

    POST /viseme   body: WAV bytes (any rate/channels)  -> JSON
    GET  /health

Env:
    VISEME_PORT       (default 9002)
    VISEME_MODEL_DIR  (default /mnt/data/speech-models/wav2arkit)
    VISEME_THREADS    (default 4)
"""

import io
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from scipy.signal import resample_poly

PORT = int(os.environ.get("VISEME_PORT", "9002"))
MODEL_DIR = os.environ.get("VISEME_MODEL_DIR", "/mnt/data/speech-models/wav2arkit")
THREADS = int(os.environ.get("VISEME_THREADS", "4"))
TARGET_SR = 16000
FPS = 30
MAX_BODY = 32 * 1024 * 1024  # 32MB — a very long utterance is still far under this

_model_path = os.path.join(MODEL_DIR, "wav2arkit_cpu.onnx")
_cfg_path = os.path.join(MODEL_DIR, "config.json")

with open(_cfg_path) as f:
    BLENDSHAPE_NAMES = json.load(f)["blendshape_names"]
IDX = {name: i for i, name in enumerate(BLENDSHAPE_NAMES)}

_so = ort.SessionOptions()
_so.intra_op_num_threads = THREADS
_so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
SESSION = ort.InferenceSession(_model_path, _so, providers=["CPUExecutionProvider"])

# The model outputs conservative magnitudes (jawOpen peaks around 0.12 on speech that
# should read as a wide-open mouth), and each axis has a different resting floor — a
# flat gain either pins the mouth open or never lets it close. These are (p5, p99)
# measured over 25.9s / 778 frames of Emma's current Fish Audio voice
# using phrase sets that exercise open vowels,
# bilabials and rounded vowels.
#
# RE-MEASURE THESE WHEN VOICE_TTS_REFERENCE_ID CHANGES. Voices differ enough to matter:
# the previous voice (沛緹) peaked at 0.669 openness against this one's 0.583, so reusing
# its constants leaves the mouth ~13% under-opened throughout.
CALIBRATION = {
    "openness": (0.0414, 0.5830),
    "width": (0.0184, 0.1700),
    "roundness": (0.0051, 0.1085),
}


def _normalise(values: np.ndarray, axis: str) -> np.ndarray:
    lo, hi = CALIBRATION[axis]
    return np.clip((values - lo) / (hi - lo), 0.0, 1.0)


def _decode_wav(raw: bytes) -> np.ndarray:
    """WAV bytes -> mono float32 @ 16kHz in [-1, 1]."""
    with wave.open(io.BytesIO(raw)) as w:
        n_ch, width, rate, n_frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        frames = w.readframes(n_frames)

    if width == 2:
        pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        pcm = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif width == 1:
        pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported sample width: {width} bytes")

    if n_ch > 1:
        pcm = pcm.reshape(-1, n_ch).mean(axis=1)

    if rate != TARGET_SR:
        from math import gcd
        g = gcd(int(rate), TARGET_SR)
        pcm = resample_poly(pcm, TARGET_SR // g, int(rate) // g).astype(np.float32)

    return np.ascontiguousarray(pcm, dtype=np.float32)


def _mouth_params(bs: np.ndarray) -> dict:
    """Collapse 52 ARKit blendshapes into the 3 axes a 2D frame library needs.

    A photoreal frame atlas is indexed by mouth shape, not by 52 independent
    coefficients, so we project onto openness / width / roundness and let the
    client pick the nearest frame.
    """
    def col(name):
        return bs[:, IDX[name]] if name in IDX else np.zeros(bs.shape[0], dtype=np.float32)

    openness = _normalise(col("jawOpen") + col("mouthLowerDownLeft") * 0.5
                          + col("mouthLowerDownRight") * 0.5 - col("mouthClose"), "openness")
    width = _normalise((col("mouthStretchLeft") + col("mouthStretchRight")
                        + col("mouthSmileLeft") + col("mouthSmileRight")) * 0.5, "width")
    roundness = _normalise((col("mouthPucker") + col("mouthFunnel")) * 0.5, "roundness")

    return {
        "openness": [round(float(v), 4) for v in openness],
        "width": [round(float(v), 4) for v in width],
        "roundness": [round(float(v), 4) for v in roundness],
    }


def analyse(wav_bytes: bytes, want_blendshapes: bool) -> dict:
    pcm = _decode_wav(wav_bytes)
    duration = len(pcm) / TARGET_SR
    t0 = time.perf_counter()
    bs = SESSION.run(None, {"audio_waveform": pcm[None, :]})[0][0]
    infer_ms = (time.perf_counter() - t0) * 1000.0

    out = {
        "fps": FPS,
        "frame_count": int(bs.shape[0]),
        "duration_ms": round(duration * 1000.0, 1),
        "infer_ms": round(infer_ms, 1),
        "realtime_factor": round(duration / max(infer_ms / 1000.0, 1e-6), 1),
        "mouth": _mouth_params(bs),
    }
    if want_blendshapes:
        out["blendshape_names"] = BLENDSHAPE_NAMES
        out["blendshapes"] = [[round(float(v), 4) for v in frame] for frame in bs]
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter than the default stderr spam
        sys.stderr.write("[viseme] %s\n" % (fmt % args))

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"status": "ok", "model": _model_path,
                             "fps": FPS, "threads": THREADS})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/viseme":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send(400, {"error": "empty body; POST WAV bytes"})
            return
        if length > MAX_BODY:
            self._send(413, {"error": f"body too large ({length} > {MAX_BODY})"})
            return

        raw = self.rfile.read(length)
        want_bs = "blendshapes=1" in (self.path.split("?")[1] if "?" in self.path else "")
        try:
            self._send(200, analyse(raw, want_bs))
        except Exception as exc:  # noqa: BLE001 - always answer, never hang the caller
            sys.stderr.write(f"[viseme] error: {exc}\n")
            self._send(500, {"error": str(exc)})


if __name__ == "__main__":
    # Warm the graph so the first real request isn't paying allocation costs.
    SESSION.run(None, {"audio_waveform": np.zeros((1, TARGET_SR), dtype=np.float32)})
    print(f"[viseme] ready on :{PORT} (model={_model_path}, threads={THREADS})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
