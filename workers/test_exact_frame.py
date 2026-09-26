import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
import av
import numpy as np

from worker import process


class ExactFrameTests(unittest.TestCase):
    def test_common_frame_rates_step_to_adjacent_pts(self):
        with tempfile.TemporaryDirectory() as directory:
            job=Path(directory)
            for fps in (24,30,60):
                source=job/f'{fps}.mkv'
                with av.open(str(source),'w',format='matroska') as output:
                    stream=output.add_stream('ffv1',rate=fps)
                    stream.width,stream.height,stream.pix_fmt=32,24,'yuv420p'
                    stream.time_base=Fraction(1,fps)
                    for index in range(12):
                        frame=av.VideoFrame.from_ndarray(np.full((24,32,3),index,dtype=np.uint8),format='rgb24')
                        frame.pts,frame.time_base=index,Fraction(1,fps)
                        for packet in stream.encode(frame):output.mux(packet)
                    for packet in stream.encode():output.mux(packet)
                with av.open(str(source)) as recorded:
                    pts=[float(frame.pts*frame.time_base) for frame in recorded.decode(video=0)]
                for direction,expected in (('previous',4),('next',6)):
                    result=process(job,{'kind':'video','operation':'frame_at','target':pts[5],'direction':direction,'source_lease':str(source)})
                    self.assertAlmostEqual(result['previews'][0]['source_relative_seconds'],pts[expected],places=5)

    def test_vfr_adjacent_frames_use_decoder_pts(self):
        source = Path(__file__).resolve().parent.parent / 'fixtures' / 'generated' / 'variable-timing.mp4'
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            for target, direction, expected in [(0.6, 'previous', 0.2), (0.6, 'next', 1.4), (1.0, 'previous', 0.6), (1.0, 'next', 1.4)]:
                result = process(job, {'kind': 'video', 'operation': 'frame_at', 'target': target, 'direction': direction, 'source_lease': str(source)})
                self.assertEqual(result['status'], 'complete')
                self.assertEqual(len(result['previews']), 1)
                frame = result['previews'][0]
                self.assertAlmostEqual(frame['source_relative_seconds'], expected, places=3)
                self.assertTrue((job / frame['path']).is_file())
                self.assertIsInstance(frame['pts'], int)
                self.assertIn('/', frame['time_base'])

    def test_unavailable_adjacent_frame_does_not_repeat_current_frame(self):
        source = Path(__file__).resolve().parent.parent / 'fixtures' / 'generated' / 'variable-timing.mp4'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'No adjacent decoded frame'):
                process(Path(directory), {'kind': 'video', 'operation': 'frame_at', 'target': 0, 'direction': 'previous', 'source_lease': str(source)})


if __name__ == '__main__':
    unittest.main()
