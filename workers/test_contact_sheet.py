import json
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import av
import numpy as np

from worker import process, write_result


def write_sample_video(path, seconds=12, fps=10, width=64, height=48):
    with av.open(str(path), 'w', format='matroska') as output:
        stream = output.add_stream('ffv1', rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, 'yuv420p'
        stream.time_base = Fraction(1, fps)
        for index in range(seconds * fps):
            frame = av.VideoFrame.from_ndarray(np.full((height, width, 3), (index * 7) % 256, dtype=np.uint8), format='rgb24')
            frame.pts, frame.time_base = index, Fraction(1, fps)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


class ContactSheetTests(unittest.TestCase):
    def test_two_by_two_sheet_covers_twelve_second_video(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'sample.mkv'
            write_sample_video(source)
            result = process(job, {'kind': 'video', 'operation': 'sheet', 'start': 0, 'end': 12, 'interval': 1, 'cols': 2, 'rows': 2, 'source_lease': str(source)})
            self.assertEqual(result['version'], 1)
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['pages'], [])
            self.assertEqual(len(result['previews']), 3)
            times = []
            for sheet_index, preview in enumerate(result['previews']):
                self.assertEqual(preview['sheet_index'], sheet_index)
                self.assertEqual(preview['path'], f'sheet-{sheet_index:03d}.jpg')
                self.assertEqual(preview['cols'], 2)
                self.assertEqual(preview['rows'], 2)
                self.assertEqual(preview['tile_width'], 640)
                self.assertEqual(preview['tile_height'], 360)
                self.assertEqual(preview['output_size'], [1280, 720])
                self.assertEqual(len(preview['tiles']), 4)
                self.assertTrue((job / preview['path']).is_file())
                for position, tile in enumerate(preview['tiles']):
                    self.assertEqual(tile['tile'], position)
                    self.assertIsInstance(tile['pts'], int)
                    self.assertIsInstance(tile['time_base'], str)
                    self.assertEqual(tile['original_size'], [64, 48])
                    times.append(tile['source_relative_seconds'])
            self.assertEqual(len(times), 12)
            self.assertTrue(all(later > earlier for earlier, later in zip(times, times[1:])))
            self.assertAlmostEqual(times[0], 0.0, places=5)
            self.assertAlmostEqual(times[-1], 11.0, places=5)
            metadata = result['metadata']
            self.assertEqual(metadata['operation'], 'sheet')
            self.assertEqual(metadata['requested_interval'], [0, 12])
            self.assertEqual(metadata['sample_interval'], 1)
            self.assertEqual(metadata['sampled_frames'], 12)
            self.assertGreater(metadata['frames_decoded'], 0)
            self.assertTrue(any('derivative' in note for note in result['limitations']))

    def test_partial_last_sheet_lists_only_used_tiles(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'sample.mkv'
            write_sample_video(source, seconds=5)
            result = process(job, {'kind': 'video', 'operation': 'sheet', 'start': 0, 'end': 5, 'interval': 1, 'cols': 2, 'rows': 2, 'source_lease': str(source)})
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(len(result['previews']), 2)
            self.assertEqual(len(result['previews'][0]['tiles']), 4)
            self.assertEqual(len(result['previews'][1]['tiles']), 1)
            self.assertEqual(result['previews'][1]['tiles'][0]['tile'], 0)
            self.assertEqual(result['metadata']['sampled_frames'], 5)

    def test_invalid_requests_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'sample.mkv'
            write_sample_video(source)
            base = {'kind': 'video', 'operation': 'sheet', 'source_lease': str(source)}
            for overrides, pattern in [
                ({'start': 0, 'end': 181, 'interval': 10}, 'window'),
                ({'start': 0, 'end': 2, 'interval': 0.25}, 'interval'),
                ({'start': 0, 'end': 65, 'interval': 1}, '64 sampled frame'),
                ({'start': 0, 'end': 2, 'interval': 1, 'cols': 5}, 'columns'),
            ]:
                with self.assertRaisesRegex(ValueError, pattern):
                    process(job, {**base, **overrides})

    def test_write_result_adds_protocol_to_complete_and_failed_results(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            complete = {'version': 1, 'status': 'complete', 'pages': [], 'metadata': {}, 'limitations': [], 'previews': []}
            write_result(job, complete)
            published = json.loads((job / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(published['status'], 'complete')
            self.assertEqual(published['protocol'], 2)
            self.assertNotIn('protocol', complete)
            write_result(job, {'version': 1, 'status': 'complete', 'metadata': {'path': 'a\ud800b'}})
            failed = json.loads((job / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(failed['status'], 'failed')
            self.assertEqual(failed['protocol'], 2)


if __name__ == '__main__':
    unittest.main()
