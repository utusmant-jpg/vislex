"""Short audio clip for the optional second-opinion add-on.

Decodes one audio track of the leased read-only source over a bounded
interval, resamples it to 16 kHz mono and writes a plain PCM WAV. The WAV is
written with the standard ``wave`` module, so it carries no container tags,
encoder strings, dates or source names: only the samples leave the machine if
a reviewer later chooses to send it. The worker has no network access; Rust
performs any transmission after a human confirms it.
"""
import wave
from pathlib import Path

MAX_CLIP_SECONDS = 30.0
RATE = 16000


def clip(job: Path, request: dict) -> dict:
    import av
    import numpy as np

    source = Path(request.get('source_lease') or (job / 'input'))
    start, end = float(request.get('start', -1)), float(request.get('end', -1))
    if not (0 <= start < end and end - start <= MAX_CLIP_SECONDS + 1e-6):
        raise ValueError('A clip must be a positive interval no longer than 30 seconds')
    with av.open(str(source)) as container:
        tracks = [s for s in container.streams if s.type == 'audio']
        if not tracks:
            raise ValueError('No audio stream exists in this source')
        wanted = request.get('track')
        track = tracks[0] if wanted is None else next((s for s in tracks if s.index == wanted), None)
        if track is None:
            raise ValueError('Audio track index does not exist')
        origin = float((track.start_time or 0) * track.time_base)
        container.seek(max(0, int((start + origin) * av.time_base)), backward=True)
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=RATE)
        audio = np.zeros(int(round((end - start) * RATE)), dtype=np.float32)
        covered = np.zeros(len(audio), dtype=bool)
        decoded = 0
        for frame in container.decode(track):
            decoded += 1
            if decoded > 100000:
                raise ValueError('Audio decode limit exceeded')
            if frame.pts is None:
                raise ValueError('Audio timestamps missing; the clip interval cannot be verified')
            if float(frame.pts * frame.time_base) - origin >= end:
                break
            for resampled in resampler.resample(frame):
                if resampled.pts is None:
                    raise ValueError('Resampled timestamp missing')
                position = float(resampled.pts * resampled.time_base) - origin
                samples = resampled.to_ndarray().reshape(-1)
                offset = round((position - start) * RATE)
                a, b = max(0, offset), min(len(audio), offset + len(samples))
                if b > a:
                    audio[a:b] = samples[a - offset:b - offset]
                    covered[a:b] = True
        if not covered.any():
            raise ValueError('No decodable audio in the requested interval')
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2')
    output = job / 'clip.wav'
    with wave.open(str(output), 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(pcm.tobytes())
    metadata = {
        'kind': 'second_opinion_clip',
        'track_index': track.index,
        'origin_seconds': origin,
        'requested_interval': [start, end],
        'decoded_seconds': float(covered.sum() / RATE),
        'gap_seconds': float((~covered).sum() / RATE),
        'sample_rate': RATE, 'channels': 1, 'encoding': 'pcm_s16le',
    }
    preview = dict(metadata, path='clip.wav', mime='audio/wav')
    notes = [
        'Derived clip for an optional second opinion; the original evidence is unchanged.',
        'Times are source-track seconds. Silence was zero-filled where the decoder reported gaps.',
    ]
    return {'version': 1, 'status': 'complete', 'pages': [], 'metadata': metadata, 'limitations': notes, 'previews': [preview]}
