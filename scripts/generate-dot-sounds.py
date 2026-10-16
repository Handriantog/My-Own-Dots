#!/usr/bin/env python3
"""Create the original desktop Dot sound audition pack using Python's stdlib.

No recordings, downloaded samples, model service, or third-party packages are
used. This builds review assets, not a runtime audio integration.
"""

import hashlib
import json
import math
from pathlib import Path
import random
import struct
import wave


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/demos/desktop-dot-audio"
RATE = 48000
TAU = math.tau


def tone(duration, start, end, *, breath=0.0, seed=0):
    """A rounded, slightly imperfect nonverbal vocal/elastic gesture."""
    rng = random.Random(seed)
    phase = 0.0
    result = []
    count = round(duration * RATE)
    noise = 0.0
    for i in range(count):
        u = i / max(1, count - 1)
        t = i / RATE
        frequency = start * (end / start) ** u
        frequency *= 1 + 0.009 * math.sin(TAU * 5.7 * t)
        phase += TAU * frequency / RATE
        noise += 0.08 * (rng.uniform(-1, 1) - noise)
        envelope = math.sin(math.pi * u) ** 1.7
        voice = math.sin(phase) + 0.13 * math.sin(phase * 2)
        result.append(envelope * (voice + breath * noise))
    return result


def fabric(duration, *, seed, softness=650, flutter=0):
    """Filtered noise with a soft onset, for cloth movement and air."""
    rng = random.Random(seed)
    fast = slow = 0.0
    a = 1 - math.exp(-TAU * softness / RATE)
    b = 1 - math.exp(-TAU * 90 / RATE)
    count = round(duration * RATE)
    result = []
    for i in range(count):
        u = i / max(1, count - 1)
        raw = rng.uniform(-1, 1)
        fast += a * (raw - fast)
        slow += b * (raw - slow)
        envelope = math.sin(math.pi * u) ** 1.5
        envelope *= 1 - flutter * 0.5 + flutter * 0.5 * math.cos(TAU * 4 * u)
        result.append((fast - slow) * envelope * 5)
    return result


def thud(duration, frequency, *, seed):
    count = round(duration * RATE)
    cloth = fabric(duration, seed=seed, softness=420)
    phase = 0.0
    result = []
    for i in range(count):
        t = i / RATE
        phase += TAU * frequency * (0.55 + 0.45 * math.exp(-t * 35)) / RATE
        envelope = (1 - math.exp(-t * 450)) * math.exp(-t * 24)
        result.append(math.sin(phase) * envelope + 0.18 * cloth[i])
    return result


def combine(*parts):
    """Parts are (offset seconds, signal, gain)."""
    count = max(round(offset * RATE) + len(signal) for offset, signal, _ in parts)
    result = [0.0] * count
    for offset, signal, gain in parts:
        start = round(offset * RATE)
        for i, value in enumerate(signal):
            result[start + i] += value * gain
    return result


# One event per meaningful action/contact; never one event per render frame.
# Level differences are intentional. Variants share the same timbre and body.
EVENTS = [
    ("appear", "Arrival", "Soft fabric unfurl with a curious upward chirp", "Once on deliberate arrival", 0.25, 1200),
    ("notice", "Noticing the pointer", "Small questioning murmur", "Once on entering attention; not every pointer move", 0.17, 1800),
    ("pat", "Click or gentle pat", "Plush squeeze and a tiny contented chirp", "Once per accepted click", 0.25, 300),
    ("pickup", "Picked up", "Fabric lift and a brief surprised chirp", "Once when dragging starts", 0.26, 350),
    ("carry", "Carried around", "Quiet fabric creak", "Only after meaningful drag movement", 0.085, 650),
    ("release", "Released", "Small airy release", "Once when dragging ends", 0.13, 250),
    ("step", "Footstep", "Tiny padded footfall", "At foot contact, matched to walking cadence", 0.085, 90),
    ("turn", "Turning", "Short fabric shuffle", "On a planted turning step", 0.07, 350),
    ("jump", "Jumping", "Compressed plush spring and an upward swish", "At takeoff", 0.22, 350),
    ("grab", "Grabbing a ledge", "Soft contact with fabric tension", "At hand contact", 0.16, 180),
    ("climb", "Climbing", "Quiet cloth grip and padded movement", "At alternating hand or foot contacts", 0.08, 160),
    ("pull_up", "Pulling onto a ledge", "Brief effort murmur and settling fabric", "At the final pull onto a platform", 0.17, 650),
    ("slip", "Losing a grip", "Short cloth slip with a surprised squeak", "Once when support is lost", 0.20, 500),
    ("fall", "Falling", "Soft descending air movement", "Once per fall after meaningful downward motion", 0.13, 650),
    ("land_soft", "Gentle landing", "Cushioned low thump and body settling", "At a low-speed landing", 0.24, 120),
    ("land_hard", "Larger landing", "Deeper plush thud with a small rebound", "At a larger landing; replaces gentle landing", 0.38, 200),
    ("bump", "Bumping an edge", "Rounded cloth-covered knock", "At a new collision, scaled by normal impact speed", 0.23, 220),
    ("sit", "Sitting", "Soft fabric folding and a padded settle", "At the seat contacting the surface", 0.11, 650),
    ("stand", "Standing up", "Small cloth stretch", "During the rise", 0.09, 500),
    ("stretch", "Stretching", "Gentle elastic creak and breath", "Once during a stretch", 0.13, 1600),
    ("yawn", "Yawning", "Sleepy rounded nonverbal breath", "Once per yawn", 0.14, 8000),
    ("sleep", "Settling to sleep", "One soft exhale", "Once on entering sleep; no repeating snore loop", 0.075, 8000),
    ("wake", "Waking up", "Quiet inquisitive murmur and rustle", "Once on waking", 0.16, 1500),
]


def make_sound(key, variant):
    seed = int.from_bytes(hashlib.sha256(f"dot-plush-v1:{key}:{variant}".encode()).digest()[:8], "big")
    rng = random.Random(seed)
    pitch = rng.uniform(0.95, 1.05)
    length = rng.uniform(0.96, 1.04)

    def voice(d, a, b, breath=0.8):
        return tone(d * length, a * pitch, b * pitch, breath=breath, seed=seed)

    def cloth(d, softness=650, flutter=0):
        return fabric(d * length, seed=seed, softness=softness, flutter=flutter)

    def tap(d, frequency):
        return thud(d * length, frequency * pitch, seed=seed)

    recipes = {
        "appear": lambda: combine((0, cloth(.45, 850), .35), (.12, voice(.26, 320, 510), .65)),
        "notice": lambda: voice(.15, 360, 510),
        "pat": lambda: combine((0, tap(.15, 210), .70), (.035, voice(.17, 430, 370), .35), (0, cloth(.24), .30)),
        "pickup": lambda: combine((0, cloth(.26, 1050), .40), (.025, voice(.18, 370, 620), .55)),
        "carry": lambda: combine((0, cloth(.22, 450, .6), .80), (.03, voice(.14, 160, 180), .12)),
        "release": lambda: cloth(.14, 1100),
        "step": lambda: combine((0, tap(.09, 180), .70), (0, cloth(.075, 700), .45)),
        "turn": lambda: cloth(.18, 560, .65),
        "jump": lambda: combine((0, tap(.10, 180), .65), (.02, voice(.16, 175, 390), .23), (.04, cloth(.20, 950), .50)),
        "grab": lambda: combine((0, tap(.10, 270), .65), (.025, cloth(.17, 620), .60)),
        "climb": lambda: combine((0, cloth(.13, 800), .70), (.015, tap(.09, 240), .35)),
        "pull_up": lambda: combine((0, cloth(.31, 460), .45), (.04, voice(.20, 220, 280, 1.3), .35), (.22, tap(.14, 180), .35)),
        "slip": lambda: combine((0, cloth(.16, 1250), .65), (.02, voice(.13, 510, 340), .30)),
        "fall": lambda: combine((0, cloth(.49, 1150), .90), (.07, voice(.31, 240, 125), .055)),
        "land_soft": lambda: combine((0, tap(.22, 130), 1), (.035, cloth(.23, 430), .40)),
        "land_hard": lambda: combine((0, tap(.26, 100), 1), (.02, cloth(.32, 560), .48), (.15, tap(.13, 155), .22)),
        "bump": lambda: combine((0, tap(.17, 195), 1), (.025, cloth(.16, 850), .30)),
        "sit": lambda: combine((0, cloth(.26, 430), .65), (.12, tap(.16, 140), .50)),
        "stand": lambda: cloth(.25, 530, .35),
        "stretch": lambda: combine((0, cloth(.48, 430), .60), (.08, voice(.34, 150, 210), .18)),
        "yawn": lambda: combine((0, voice(.66, 240, 125, 2.0), .35), (.14, cloth(.58, 430), .45)),
        "sleep": lambda: cloth(.65, 340),
        "wake": lambda: combine((0, cloth(.36, 620), .50), (.09, voice(.25, 210, 350, 1.4), .35)),
    }
    return recipes[key]()


def finish(signal, peak):
    # Remove DC, soften sample boundaries, and leave explicit headroom.
    mean = sum(signal) / len(signal)
    result = [value - mean for value in signal]
    fade = min(round(.006 * RATE), len(result) // 4)
    for i in range(fade):
        gain = .5 - .5 * math.cos(math.pi * i / max(1, fade - 1))
        result[i] *= gain
        result[-1 - i] *= gain
    gain = peak / max(abs(value) for value in result)
    return [0.0] * 96 + [value * gain for value in result] + [0.0] * 480


def save_wav(path, signal):
    assert all(math.isfinite(x) and abs(x) < 1 for x in signal)
    samples = [round(value * 32767) for value in signal]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def markdown_table(headers, rows):
    widths = [max(3, len(header), *(len(row[i]) for row in rows))
              for i, header in enumerate(headers)]

    def line(cells):
        return "| " + " | ".join(cell.ljust(width) for cell, width in zip(cells, widths)) + " |"

    return "\n".join([line(headers), line(["-" * width for width in widths]),
                      *(line(row) for row in rows)])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    clips = {}
    catalog = []
    for key, label, character, trigger, peak, cooldown in EVENTS:
        files = []
        for variant in range(1, 4):
            signal = finish(make_sound(key, variant), peak)
            filename = f"{key}-{variant:02d}.wav"
            save_wav(OUT / filename, signal)
            clips[(key, variant)] = signal
            files.append({"file": filename, "durationSeconds": round(len(signal) / RATE, 4)})
        catalog.append({
            "event": key, "label": label, "sound": character,
            "trigger": trigger, "cooldownMs": cooldown,
            "peakDbfs": round(20 * math.log10(peak), 2), "variants": files,
        })

    # A narrative audition with the same relative levels as the individual clips.
    sequence = [
        (.35, "appear", 1), (1.5, "notice", 1), (2.3, "pat", 1),
        (3.3, "pickup", 1), (4.1, "carry", 1), (4.85, "carry", 2),
        (5.6, "release", 1), (5.85, "fall", 1), (6.4, "land_soft", 1),
        (7.3, "step", 1), (7.65, "step", 2), (8.0, "step", 3),
        (8.35, "step", 1), (8.8, "turn", 1), (9.55, "jump", 1),
        (10.1, "grab", 1), (10.6, "climb", 1), (11.0, "climb", 2),
        (11.4, "climb", 3), (12.0, "pull_up", 1), (13.0, "bump", 1),
        (14.0, "slip", 1), (14.25, "fall", 2), (14.9, "land_hard", 1),
        (16.0, "sit", 1), (17.0, "stand", 1), (18.0, "stretch", 1),
        (19.2, "yawn", 1), (20.5, "sleep", 1), (22.2, "wake", 1),
    ]
    preview = combine(*[(at, clips[(key, variant)], 1) for at, key, variant in sequence])
    preview += [0.0] * RATE
    save_wav(OUT / "dot-sound-preview.wav", preview)
    manifest = {
        "version": 1, "status": "audition assets; runtime integration pending",
        "character": "one plush Dot; body color does not change its sound identity",
        "provenance": "Original deterministic procedural synthesis in scripts/generate-dot-sounds.py. No external samples.",
        "format": {"sampleRate": RATE, "channels": 1, "encoding": "PCM signed 16-bit WAV"},
        "events": catalog,
        "preview": {"file": "dot-sound-preview.wav", "durationSeconds": round(len(preview) / RATE, 3),
                    "timeline": [{"atSeconds": at, "event": key, "variant": v} for at, key, v in sequence]},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    rows = markdown_table(["Event", "Interaction", "Sound", "Trigger"],
                          [(key, label, sound, trigger) for key, label, sound, trigger, _, _ in EVENTS])
    timeline = markdown_table(["Time", "Event"], [(f"{at:.2f}s", key) for at, key, _ in sequence])
    readme = f"""# Desktop Dot sound audition

Original sound effects for one plush desktop Dot: soft cloth movement, padded
contacts, gentle air movement, and small nonverbal reactions. These are review
assets. The desktop app and runtime sound scheduler are not implemented here.

Listen to [the {len(preview) / RATE:.1f} second preview](dot-sound-preview.wav).
The preview tells a short action sequence; it does not demonstrate live physics
or measured animation synchronization. It keeps each sound's intended relative
level. Quiet footsteps and cloth movements are deliberately softer than impacts.

There are {len(EVENTS)} event families and three variations per family
({len(EVENTS) * 3} individual effects), all mono 48 kHz 16-bit PCM WAV.
The body color does not change the sound identity. Every clip is generated
locally from oscillators and filtered noise; no external recordings or samples
are used. Rebuild with Python 3's standard library:

```sh
python3 scripts/generate-dot-sounds.py
```

## Sound catalog

{rows}

## Runtime behavior to implement

- Emit sound from the same action/contact event that drives movement and
  animation. Footsteps follow planted feet; impacts follow contact. Do not
  trigger from render frames, repeated overlap checks, or animation rerenders.
- Treat action instances and contacts as identifiable events. Deduplicate
  them before playback. The catalog cooldowns are initial tuning values.
- Select among variants without immediately repeating the previous variant.
  Limit additional playback-rate variation to roughly three percent to retain
  the same character identity. Do not randomize every audio property.
- Use the supplied level differences. Start master effects volume at 40 percent
  and expose a persistent volume control and mute in the menu-bar utility.
  Effects follow the user's selected system output and system volume.
- Land-soft and land-hard are mutually exclusive responses to a landing.
  Scale impact gain by normal impact speed, with a bounded maximum. Use the
  hard clip only above a tuned impact threshold; a tiny touch stays quiet.
- Fall is a one-shot onset cue. Cancel/fade it when Dot lands or is grabbed.
  A long fall must not retrigger it periodically. A future sustained air layer,
  if needed, must follow fall speed and crossfade without a loop seam.
- Hover attention has a cooldown. Carry sounds require meaningful movement.
  Idling, blinking, resting contact, recoloring, and sleeping do not produce
  repeated effects. Sleep has one settling breath, not a continuous snore.
- Mix at most four voices. Give direct interaction and collision effects
  priority over footsteps and ambient gestures. Fade interrupted sounds rather
  than chopping them off. Suppress stale events after sleep, pause, or resume.
- Pan gently according to Dot's horizontal position on its current display.
  Smooth movement between positions; keep the supplied files mono so the
  runtime owns spatial placement. Keep extreme stereo separation out of the
  default experience.
- Preload/decode the small sound library before interaction. Use the shared
  simulation clock for event timing and measure audible synchronization on
  the supported Macs; do not claim zero output latency, particularly over
  Bluetooth.
- Mute is immediate and persistent. Hide/exit, when added, fade active sounds
  and cancel scheduled ones. Muting audio does not change physical behavior.

## Preview timeline

{timeline}

## Review criteria

Check the palette on speakers and headphones at ordinary volume. Effects should
feel soft and small, with footsteps quieter than landings. Check that vocal
gestures feel like one character, and listen for clicks, harsh high frequencies,
excessive bass, and fatigue during repetition. Waveform/format checks establish
file integrity; subjective sound quality and live synchronization still require
listening and integration review.
"""
    (OUT / "README.md").write_text(readme)
    print(json.dumps({"events": len(EVENTS), "effects": len(EVENTS) * 3,
                      "previewSeconds": round(len(preview) / RATE, 2), "directory": str(OUT)}))


if __name__ == "__main__":
    main()
