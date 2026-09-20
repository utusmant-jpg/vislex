"""Bounded, channel-specific transient discovery. Candidates are NOT classified knocks."""
from __future__ import annotations
import json
import math
import numpy as np

VERSION = 'transient-discovery-1'

def analyze(samples, covered, rate, start=0.0):
    samples = np.asarray(samples, dtype=np.float32)
    covered = np.asarray(covered, dtype=bool)
    if samples.ndim != 1 or covered.shape != samples.shape or not 8000 <= rate <= 192000:
        raise ValueError('Invalid signal or sample rate')
    if not np.isfinite(samples).all() or len(samples) > rate * 60:
        raise ValueError('Nonfinite or oversized signal')
    hop = max(1, round(rate * .005))
    bins = len(samples) // hop
    if bins < 2:
        raise ValueError('Insufficient decoded interval')
    blocks = samples[:bins * hop].reshape(bins, hop)
    valid = covered[:bins * hop].reshape(bins, hop).all(axis=1)
    peak = np.max(np.abs(blocks), axis=1)
    rms = np.sqrt(np.mean(blocks ** 2, axis=1))
    candidates = []
    last = -1000
    for i in range(1, bins - 1):
        # Never turn a decoder gap, or its immediate boundary, into an impact.
        lo = max(0, i - 40)
        if not valid[max(0, i - 2):i + 2].all() or i - last < 14:
            continue
        history = rms[lo:i][valid[lo:i]]
        if len(history) < 4:
            continue
        median = float(np.median(history))
        mad = float(np.median(np.abs(history - median)))
        threshold = max(.003, median * 3., median + 8. * mad)
        if rms[i] <= threshold or rms[i] <= rms[i - 1] * 1.8:
            continue
        # Inspect local sample crossings within the detected 5 ms bin.
        crossings = np.flatnonzero(np.abs(blocks[i]) >= max(.008, median * 4.))
        onset = i * hop + (int(crossings[0]) if len(crossings) else 0)
        neighborhood = samples[max(0, onset - hop):min(len(samples), onset + hop * 8)]
        candidates.append({
            'source_relative_seconds': start + onset / rate,
            'analysis_sample_index': str(onset),
            'onset_resolution_seconds': hop / rate,
            'energy_ratio': float(rms[i] / max(median, .00001)),
            'peak_amplitude': float(peak[i]),
            'clipping_fraction': float(np.mean(np.abs(neighborhood) >= .999)),
            'label': 'unclassified transient',
            'alternatives': ['knock or impact', 'handling noise', 'speech transient', 'other sound'],
            'review': 'unreviewed',
        })
        last = i
    bursts = []
    for i, event in enumerate(candidates):
        if not bursts or event['source_relative_seconds'] - bursts[-1]['end_seconds'] > .8:
            bursts.append({'start_seconds': event['source_relative_seconds'], 'end_seconds': event['source_relative_seconds'], 'candidate_indices': []})
        bursts[-1]['end_seconds'] = event['source_relative_seconds']
        bursts[-1]['candidate_indices'].append(i)
    for burst in bursts:
        burst['candidate_count'] = len(burst['candidate_indices'])
        burst['count_interpretation'] = 'Detected transients only. Merged or missed impacts and non-impact sounds remain possible.'
    # Display summary, independent of candidate thresholds. Gaps remain explicit.
    stride = max(1, math.ceil(bins / 1500))
    waveform = [{'start_seconds': start + i * hop / rate,
                 'peak': float(np.max(peak[i:i + stride])),
                 'rms': float(np.mean(rms[i:i + stride])),
                 'fully_decoded': bool(valid[i:i + stride].all())}
                for i in range(0, bins, stride)]
    return {'candidates': candidates, 'bursts': bursts, 'waveform': waveform,
            'decoded_seconds': float(covered.sum() / rate),
            'gap_seconds': float((~covered).sum() / rate),
            'count_is_knock_count': False, 'score_is_probability': False}

def scan(source, request):
    import av
    start, end = float(request.get('start', 0)), float(request.get('end', 30))
    if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end and end - start <= 60):
        raise ValueError('Sound discovery requires a finite interval of at most 60 seconds')
    channel = request.get('channel', 0)
    if not isinstance(channel, int) or channel < 0:
        raise ValueError('Select a nonnegative channel index')
    with av.open(str(source)) as container:
        tracks = list(container.streams.audio)
        track = next((t for t in tracks if request.get('track') in (None, t.index)), None)
        if track is None:
            raise ValueError('Selected audio stream is unavailable')
        rate = track.codec_context.sample_rate
        if not 8000 <= rate <= 192000:
            raise ValueError('Unsupported audio sample rate')
        channels = len(track.codec_context.layout.channels)
        if channel >= channels:
            raise ValueError('Selected channel is unavailable')
        origin = float((track.start_time or 0) * track.time_base)
        container.seek(max(0, int((start + origin) * av.time_base)), backward=True)
        converter = av.AudioResampler(format='fltp', layout=track.codec_context.layout.name, rate=rate)
        signal = np.zeros(math.ceil((end - start) * rate), dtype=np.float32)
        covered = np.zeros(len(signal), dtype=bool)
        anchors = []
        for count, frame in enumerate(container.decode(track)):
            if count >= 100000:
                raise ValueError('Decoder resource bound reached; no complete scan published')
            if frame.pts is None:
                raise ValueError('Missing audio timestamp; cannot place candidate events')
            if float(frame.pts * frame.time_base) - origin >= end:
                break
            for converted in converter.resample(frame):
                if converted.pts is None:
                    raise ValueError('Converted timestamp missing')
                offset = round((float(converted.pts * converted.time_base) - origin - start) * rate)
                samples = converted.to_ndarray()[channel]
                a, b = max(0, offset), min(len(signal), offset + len(samples))
                if b <= a:
                    continue
                if covered[a:b].any():
                    raise ValueError('Overlapping or reset audio timestamps require segmented analysis')
                signal[a:b] = samples[a - offset:b - offset]
                covered[a:b] = True
                anchors.append({'pts': str(frame.pts), 'timebase_num': frame.time_base.numerator,
                                'timebase_den': frame.time_base.denominator, 'analysis_sample_start': str(a)})
        if not covered.any():
            raise ValueError('No decoded signal; no absence conclusion can be made')
        result = analyze(signal, covered, rate, start)
        metadata = {**result, 'processor': VERSION, 'track_index': track.index, 'channel': channel,
                    'sample_rate': rate, 'requested_interval': [start, end], 'origin_seconds': origin,
                    'native_frame_anchors': anchors, 'audio_tracks': [{'index': t.index, 'channels': len(t.codec_context.layout.channels)} for t in tracks],
                    'time_convention': 'Source-relative to selected stream start. Analysis sample indices are relative to requested start, not original-file sample locators.'}
    pages = [{'locator': f'transient:{i}', 'text': json.dumps(event), 'method': VERSION} for i, event in enumerate(result['candidates'])]
    return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'previews': [],
            'limitations': ['Uncalibrated transient discovery, not knock classification. No precision or recall claim.',
                            'Only the selected stream/channel and interval were inspected; other channels and intervals remain unprocessed.',
                            'Candidate counts are not established impact counts. Check original playback, surrounding context and alternate sound explanations.',
                            'No speaker identity, direction, emotion or incident-time synchronization is inferred.']}
