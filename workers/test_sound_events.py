import tempfile
import unittest
import wave
from pathlib import Path
import numpy as np
from sound_events import analyze, scan


class SoundDiscoveryTests(unittest.TestCase):
    def test_three_synthetic_impacts_are_candidates_not_classified_knocks(self):
        rate = 16000
        signal = np.zeros(rate * 2, dtype=np.float32)
        for at in [.5, .8, 1.1]:
            signal[int(at * rate):int(at * rate) + 48] = .4
        result = analyze(signal, np.ones(len(signal), dtype=bool), rate)
        self.assertEqual(len(result['candidates']), 3)
        self.assertFalse(result['count_is_knock_count'])
        self.assertFalse(result['score_is_probability'])
        for event, expected in zip(result['candidates'], [.5, .8, 1.1]):
            self.assertLess(abs(event['source_relative_seconds'] - expected), .01)

    def test_silence_and_gap_boundaries_do_not_become_events(self):
        signal = np.zeros(32000, dtype=np.float32)
        self.assertEqual(analyze(signal, np.ones(32000, dtype=bool), 16000)['candidates'], [])
        signal[8000:10000] = .5
        covered = np.ones(32000, dtype=bool)
        covered[7900:8000] = False
        result = analyze(signal, covered, 16000)
        self.assertEqual(result['candidates'], [])
        self.assertGreater(result['gap_seconds'], 0)
        self.assertTrue(any(not tile['fully_decoded'] for tile in result['waveform']))

    def test_real_decoder_keeps_channels_separate_and_native_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'two-channels.wav'
            samples = np.zeros((32000, 2), dtype='<i2')
            samples[8000:8048, 1] = 15000
            with wave.open(str(source), 'wb') as output:
                output.setnchannels(2); output.setsampwidth(2); output.setframerate(16000)
                output.writeframes(samples.tobytes())
            left = scan(source, {'start': 0, 'end': 2, 'channel': 0})
            right = scan(source, {'start': 0, 'end': 2, 'channel': 1})
            self.assertEqual(left['metadata']['candidates'], [])
            self.assertEqual(len(right['metadata']['candidates']), 1)
            self.assertEqual(right['metadata']['channel'], 1)
            self.assertIsInstance(right['metadata']['native_frame_anchors'][0]['pts'], str)
            self.assertEqual(right['metadata']['gap_seconds'], 0)
            with self.assertRaises(ValueError):
                scan(source, {'start': 0, 'end': 2, 'channel': 2})

    def test_clipping_and_invalid_intervals_are_reported(self):
        signal = np.zeros(32000, dtype=np.float32); signal[8000:8048] = 1.
        result = analyze(signal, np.ones(32000, dtype=bool), 16000)
        self.assertGreater(result['candidates'][0]['clipping_fraction'], 0)
        with self.assertRaises(ValueError):
            scan('unused', {'start': 0, 'end': 61, 'channel': 0})


if __name__ == '__main__':
    unittest.main()
