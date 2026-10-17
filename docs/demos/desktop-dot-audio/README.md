# Desktop Dot sound audition

Original sound effects for one plush desktop Dot: soft cloth movement, padded
contacts, gentle air movement, and small nonverbal reactions. These are review
assets. The desktop app and runtime sound scheduler are not implemented here.

Listen to [the 23.6 second preview](dot-sound-preview.wav).
The preview tells a short action sequence; it does not demonstrate live physics
or measured animation synchronization. It keeps each sound's intended relative
level. Quiet footsteps and cloth movements are deliberately softer than impacts.

There are 23 event families and three variations per family
(69 individual effects), all mono 48 kHz 16-bit PCM WAV.
The body color does not change the sound identity. Every clip is generated
locally from oscillators and filtered noise; no external recordings or samples
are used. Rebuild with Python 3's standard library:

```sh
python3 scripts/generate-dot-sounds.py
```

## Sound catalog

| Event     | Interaction          | Sound                                          | Trigger                                            |
| --------- | -------------------- | ---------------------------------------------- | -------------------------------------------------- |
| appear    | Arrival              | Soft fabric unfurl with a curious upward chirp | Once on deliberate arrival                         |
| notice    | Noticing the pointer | Small questioning murmur                       | Once on entering attention; not every pointer move |
| pat       | Click or gentle pat  | Plush squeeze and a tiny contented chirp       | Once per accepted click                            |
| pickup    | Picked up            | Fabric lift and a brief surprised chirp        | Once when dragging starts                          |
| carry     | Carried around       | Quiet fabric creak                             | Only after meaningful drag movement                |
| release   | Released             | Small airy release                             | Once when dragging ends                            |
| step      | Footstep             | Tiny padded footfall                           | At foot contact, matched to walking cadence        |
| turn      | Turning              | Short fabric shuffle                           | On a planted turning step                          |
| jump      | Jumping              | Compressed plush spring and an upward swish    | At takeoff                                         |
| grab      | Grabbing a ledge     | Soft contact with fabric tension               | At hand contact                                    |
| climb     | Climbing             | Quiet cloth grip and padded movement           | At alternating hand or foot contacts               |
| pull_up   | Pulling onto a ledge | Brief effort murmur and settling fabric        | At the final pull onto a platform                  |
| slip      | Losing a grip        | Short cloth slip with a surprised squeak       | Once when support is lost                          |
| fall      | Falling              | Soft descending air movement                   | Once per fall after meaningful downward motion     |
| land_soft | Gentle landing       | Cushioned low thump and body settling          | At a low-speed landing                             |
| land_hard | Larger landing       | Deeper plush thud with a small rebound         | At a larger landing; replaces gentle landing       |
| bump      | Bumping an edge      | Rounded cloth-covered knock                    | At a new collision, scaled by normal impact speed  |
| sit       | Sitting              | Soft fabric folding and a padded settle        | At the seat contacting the surface                 |
| stand     | Standing up          | Small cloth stretch                            | During the rise                                    |
| stretch   | Stretching           | Gentle elastic creak and breath                | Once during a stretch                              |
| yawn      | Yawning              | Sleepy rounded nonverbal breath                | Once per yawn                                      |
| sleep     | Settling to sleep    | One soft exhale                                | Once on entering sleep; no repeating snore loop    |
| wake      | Waking up            | Quiet inquisitive murmur and rustle            | Once on waking                                     |

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

| Time   | Event     |
| ------ | --------- |
| 0.35s  | appear    |
| 1.50s  | notice    |
| 2.30s  | pat       |
| 3.30s  | pickup    |
| 4.10s  | carry     |
| 4.85s  | carry     |
| 5.60s  | release   |
| 5.85s  | fall      |
| 6.40s  | land_soft |
| 7.30s  | step      |
| 7.65s  | step      |
| 8.00s  | step      |
| 8.35s  | step      |
| 8.80s  | turn      |
| 9.55s  | jump      |
| 10.10s | grab      |
| 10.60s | climb     |
| 11.00s | climb     |
| 11.40s | climb     |
| 12.00s | pull_up   |
| 13.00s | bump      |
| 14.00s | slip      |
| 14.25s | fall      |
| 14.90s | land_hard |
| 16.00s | sit       |
| 17.00s | stand     |
| 18.00s | stretch   |
| 19.20s | yawn      |
| 20.50s | sleep     |
| 22.20s | wake      |

## Review criteria

Check the palette on speakers and headphones at ordinary volume. Effects should
feel soft and small, with footsteps quieter than landings. Check that vocal
gestures feel like one character, and listen for clicks, harsh high frequencies,
excessive bass, and fatigue during repetition. Waveform/format checks establish
file integrity; subjective sound quality and live synchronization still require
listening and integration review.
