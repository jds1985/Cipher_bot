# v1.16: generates src/renderer/assets/send.wav, the optional send sound. Synthesized here (no downloaded assets):
# a soft 140 ms two-note chime (880 Hz then 1320 Hz), 22.05 kHz mono 16-bit, with a short fade in/out.
import math, struct, wave

RATE, DUR = 22050, 0.14
n = int(RATE * DUR)
frames = bytearray()
for i in range(n):
    t = i / RATE
    f = 880 if t < DUR / 2 else 1320
    env = min(1.0, i / (RATE * 0.005)) * math.exp(-t * 18)
    frames += struct.pack('<h', int(0.35 * 32767 * env * math.sin(2 * math.pi * f * t)))
with wave.open('src/renderer/assets/send.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(bytes(frames))
print('ok', n, 'frames')
