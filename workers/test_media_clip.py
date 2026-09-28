import tempfile
import unittest
import wave
from fractions import Fraction
from pathlib import Path

import av
import numpy as np

from worker import process


def synthetic_audio(path: Path, seconds: float = 6.0, rate: int = 8000) -> None:
    with av.open(str(path), 'w', format='wav') as output:
        stream = output.add_stream('pcm_s16le', rate=rate)
        stream.layout = 'mono'
        samples = (np.sin(np.arange(int(seconds * rate)) * 2 * np.pi * 440 / rate) * 0.3 * 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format='s16', layout='mono')
        frame.sample_rate, frame.pts, frame.time_base = rate, 0, Fraction(1, rate)
        for packet in stream.encode(frame):
            output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


class MediaClipTests(unittest.TestCase):
    def test_clip_is_bounded_mono_16k_wav_without_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'source.wav'
            synthetic_audio(source)
            result = process(job, {'kind': 'media_clip', 'start': 1.5, 'end': 4.0, 'source_lease': str(source)})
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['pages'], [])
            preview = result['previews'][0]
            self.assertEqual(preview['mime'], 'audio/wav')
            self.assertEqual(preview['requested_interval'], [1.5, 4.0])
            with wave.open(str(job / preview['path']), 'rb') as clip:
                self.assertEqual((clip.getnchannels(), clip.getsampwidth(), clip.getframerate()), (1, 2, 16000))
                self.assertEqual(clip.getnframes(), 40000)
                audio = np.frombuffer(clip.readframes(clip.getnframes()), dtype='<i2')
            self.assertGreater(np.abs(audio).max(), 1000, 'the clip contains the decoded tone')
            raw = (job / 'clip.wav').read_bytes()
            self.assertEqual(raw[:4], b'RIFF')
            self.assertNotIn(b'LIST', raw, 'no INFO/metadata chunk is written')
            self.assertNotIn(b'source', raw)

    def test_oversized_or_invalid_intervals_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'source.wav'
            synthetic_audio(source)
            for start, end in ((0, 31), (3, 2), (-1, 2)):
                with self.assertRaises(ValueError):
                    process(job, {'kind': 'media_clip', 'start': start, 'end': end, 'source_lease': str(source)})


if __name__ == '__main__':
    unittest.main()
