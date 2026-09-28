"""Bounded video discovery. Decoder timestamps are evidence; samples are not coverage."""
import math
from pathlib import Path


def _detector_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1.0, 640 / width, 360 / height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def discover(job: Path, request: dict) -> dict:
    import av
    start = float(request.get('start', 0))
    end = float(request.get('end', start + 60))
    interval = float(request.get('interval', 5))
    mode = request['kind']
    if mode not in ('video_ocr', 'video_overview') or not all(math.isfinite(v) for v in (start, end, interval)) or not 0 <= start < end or end-start > 60 or not 1 <= interval <= 60:
        raise ValueError('Discovery requires a finite interval of at most 60 seconds and sampling every 1–60 seconds')
    detector = None
    if mode == 'video_overview':
        from scenedetect import ContentDetector
        from scenedetect.common import FrameTimecode, Timecode
        import numpy as np
        detector = ContentDetector(threshold=27.0, min_scene_len=0)
    previews, failures, samples, boundaries = [], [], [], []
    next_sample = math.ceil(start / interval) * interval
    decoded, missing_pts, eof = 0, 0, True
    previous = None
    last_cut = -math.inf
    source = Path(request['source_lease']) if request.get('source_lease') else job / 'input'
    with av.open(str(source)) as container:
        index = request.get('stream')
        video = next((s for s in container.streams.video if index is None or s.index == index), None)
        if video is None:
            raise ValueError('No matching video stream')
        origin = float((video.start_time or 0) * video.time_base)
        container_origin = (container.start_time or 0) / av.time_base
        # One predecessor suffices for the content metric; the warm-up also retains cut cooldown.
        seek_seconds = max(0, start - 1) + origin
        container.seek(int(seek_seconds / float(video.time_base)), stream=video, backward=True)
        for frame in container.decode(video):
            if (job / 'cancel.request').exists():
                raise RuntimeError('Discovery cancelled; previously published chunks remain available')
            decoded += 1
            if decoded > 120000:
                raise ValueError('Decode limit reached; chunk remains unprocessed')
            if frame.pts is None:
                missing_pts += 1
                continue
            presentation = float(frame.pts * frame.time_base)
            relative = presentation - origin
            if relative >= end:
                eof = False
                break
            if previous is not None and relative <= previous:
                raise ValueError('Non-increasing decoder timestamps; chunk requires inspection')
            previous = relative
            cut = False
            if detector is not None:
                # Scale in FFmpeg before converting to an array. Converting a
                # full-resolution frame to PIL and then shrinking it made long
                # recordings spend most of discovery in image conversion.
                width, height = _detector_size(frame.width, frame.height)
                rgb = frame.reformat(width=width, height=height, format='rgb24').to_ndarray()
                cut = bool(detector.process_frame(FrameTimecode(Timecode(frame.pts, frame.time_base), fps=video.average_rate or 30), rgb[:, :, ::-1]))
                if cut and relative-last_cut >= .5:
                    last_cut = relative
                else:
                    cut = False
            if relative < start:
                continue
            periodic = relative + 1e-7 >= next_sample
            if periodic:
                next_sample = (math.floor(relative / interval) + 1) * interval
            if cut:
                boundaries.append(relative)
            if not periodic and not cut:
                continue
            if len(previews) >= 180:
                failures.append({'seconds': relative, 'reason': 'thumbnail limit; frame omitted'})
                continue
            image = frame.to_image()
            original_size = list(image.size)
            image.thumbnail((1920, 1080))
            entry = {'path': f'frame-{len(previews):03d}.jpg', 'pts': frame.pts,
                     'time_base': str(frame.time_base), 'source_relative_seconds': relative,
                     'presentation_seconds': presentation, 'playback_seconds': presentation-container_origin,
                     'origin_seconds': origin, 'container_origin_seconds': container_origin,
                     'video_stream': video.index, 'original_size': original_size, 'output_size': list(image.size),
                     'periodic': periodic, 'scene_boundary': cut, 'discovery_only': True}
            if mode == 'video_ocr':
                try:
                    from automatic_ocr import recognize
                    entry['ocr'] = recognize(image, f'pts:{frame.pts}:{frame.time_base}')
                except Exception as exc:
                    entry['ocr_error'] = str(exc)[:500]
                    failures.append({'seconds': relative, 'reason': 'OCR failed: ' + str(exc)[:500]})
            image.save(job / entry['path'], quality=92)
            previews.append(entry)
            samples.append(relative)
        metadata = {'kind': mode, 'video_stream': video.index, 'origin_seconds': origin,
                    'container_origin_seconds': container_origin, 'requested_interval': [start, end],
                    'sample_interval': interval, 'sampled_seconds': samples, 'scene_boundaries': boundaries,
                    'frames_decoded': decoded, 'missing_pts_frames': missing_pts, 'failures': failures,
                    'eof': eof, 'last_decoded_seconds': previous, 'model_inspected': False,
                    'detector': 'PySceneDetect ContentDetector threshold=27 min_scene_len=0 cooldown=.5s' if detector else None,
                    'coverage': {'sampled_seconds': samples, 'continuous_visual_review': False}}
    return {'version': 1, 'status': 'complete', 'pages': [], 'previews': previews, 'metadata': metadata,
            'limitations': ['Discovery samples are navigation leads, not continuous visual inspection.',
                           'Text and actions between samples can be missed. Zero hits do not prove absence.',
                           'Displayed camera clocks are OCR text, not verified capture times.',
                           'Missing timestamps, OCR failures and omitted thumbnails are reported separately.']}
