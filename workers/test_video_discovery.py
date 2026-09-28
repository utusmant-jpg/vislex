import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch
import av
import numpy as np
from video_discovery import discover, _detector_size


def recording(path):
    with av.open(str(path), 'w', format='matroska') as out:
        stream = out.add_stream('ffv1', rate=10)
        stream.width, stream.height, stream.pix_fmt = 160, 90, 'yuv420p'
        stream.time_base = Fraction(1, 1000)
        for index in range(130):
            # A source clock starting at 3 seconds and a cut between periodic samples.
            rgb = np.zeros((90, 160, 3), dtype=np.uint8)
            rgb[:, :, 0 if index < 23 else 2] = 255
            frame = av.VideoFrame.from_ndarray(rgb, format='rgb24')
            frame.pts, frame.time_base = 3000+index*100, Fraction(1, 1000)
            for packet in stream.encode(frame): out.mux(packet)
        for packet in stream.encode(): out.mux(packet)


class VideoDiscovery(unittest.TestCase):
    def test_detector_scale_preserves_aspect_and_never_upscales(self):
        self.assertEqual(_detector_size(1024, 768), (480, 360))
        self.assertEqual(_detector_size(160, 90), (160, 90))
        self.assertEqual(_detector_size(1920, 1080), (640, 360))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.job = Path(self.tmp.name)
        recording(self.job/'input')

    def tearDown(self): self.tmp.cleanup()

    def test_actual_pts_and_scene_between_periodic_samples(self):
        result = discover(self.job, {'kind':'video_overview','start':0,'end':60,'interval':5})
        self.assertTrue(result['metadata']['eof'])
        self.assertTrue(result['metadata']['scene_boundaries'])
        self.assertTrue(any(2 < t < 3 for t in result['metadata']['scene_boundaries']))
        periodic = [p for p in result['previews'] if p['periodic']]
        self.assertEqual(len(periodic), 3)
        for sample in result['previews']:
            self.assertAlmostEqual(sample['presentation_seconds'], sample['pts']*Fraction(sample['time_base']))
            self.assertAlmostEqual(sample['playback_seconds'], sample['presentation_seconds']-sample['container_origin_seconds'])
        self.assertFalse(result['metadata']['model_inspected'])

    def test_ocr_empty_vs_failure_and_no_transcript_pages(self):
        outcomes = [{'text':'CAM 14:22','blocks':[]}, {'text':'','blocks':[]}, RuntimeError('synthetic OCR failure')]
        with patch('automatic_ocr.recognize', side_effect=outcomes):
            result = discover(self.job, {'kind':'video_ocr','start':0,'end':60,'interval':5})
        self.assertEqual(result['pages'], [])
        self.assertEqual(result['previews'][1]['ocr']['text'], '')
        self.assertIn('ocr_error', result['previews'][2])
        self.assertEqual(len(result['metadata']['failures']), 1)

    def test_chunk_boundary_and_cancel(self):
        first = discover(self.job, {'kind':'video_overview','start':0,'end':5,'interval':5})
        second = discover(self.job, {'kind':'video_overview','start':5,'end':10,'interval':5})
        self.assertFalse(first['metadata']['eof'])
        self.assertTrue(all(p['source_relative_seconds']<5 for p in first['previews']))
        self.assertTrue(all(p['source_relative_seconds']>=5 for p in second['previews']))
        (self.job/'cancel.request').touch()
        with self.assertRaisesRegex(RuntimeError,'cancelled'):
            discover(self.job, {'kind':'video_ocr','start':0,'end':60,'interval':5})

    def test_invalid_ranges(self):
        for options in ({'start':float('nan')}, {'interval':0}, {'end':61}):
            with self.assertRaises(ValueError):
                discover(self.job, {'kind':'video_ocr','start':0,'end':60,'interval':5,**options})

if __name__ == '__main__': unittest.main()
