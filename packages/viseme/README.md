# Viseme service

Audio in, mouth curve out. A small HTTP service around an ONNX model, CPU-only, roughly 25×
realtime on a desktop core.

```
POST /viseme   body: a wav file
→ { "fps": 30, "mouth": { "openness": [...], "width": [...], "roundness": [...] } }
```

**This service is optional.** Without it the sidecar falls back to a loudness envelope,
which needs no model and no install. The envelope is honestly not lip sync — openness tracks
volume, which is roughly right for vowels and wrong for everything else — but it is enough
to confirm the audio, timing and rendering all line up before committing to a 400MB
download.

## Install

```bash
python3 -m venv venv
venv/bin/pip install onnxruntime numpy
```

The model is not in this repository. Fetch `wav2arkit_cpu.onnx` (and its `.onnx.data`
sidecar) into `models/`, or point `VISEME_MODEL_DIR` at wherever you keep it. See the
[NOTICE](../../NOTICE) for what it is made of and under what terms.

```bash
VISEME_MODEL_DIR=/path/to/wav2arkit venv/bin/python server.py
```

## Why three numbers and not 52

The model emits the full ARKit blendshape set. The renderer needs three axes, because a
sprite library that spans 52 dimensions would need thousands of images:

| axis | derived from |
|---|---|
| `openness` | `jawOpen`, minus `mouthClose` |
| `width` | `mouthStretch*` and `mouthSmile*` against `mouthPucker` |
| `roundness` | `mouthPucker` and `mouthFunnel` |

Each is then normalised against a calibration recording, because the raw ranges are narrow
and voice-dependent. `CALIBRATION` in `server.py` holds the measured minimum and maximum per
axis; recalibrate when you change voice.

## What it will not give you

Blinks. Measured over real speech, the model reports `eyeBlink*` at roughly noise level
(0.0001 standard deviation) — blinking simply is not predictable from what someone is
saying. The renderer blinks on a timer instead, as every system that appears to do otherwise
is also doing.
