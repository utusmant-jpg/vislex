"""Bounded-memory, all-track transcription. Invoked only inside the worker sandbox."""
import json
import hashlib
import os
from pathlib import Path
import sys


def transcribe(job: Path, source: Path, model_name: str = "tiny") -> dict:
    import av
    import numpy as np
    from faster_whisper import WhisperModel

    if model_name not in ('tiny', 'small'):
        raise ValueError('Unsupported local speech profile')
    model_root = Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'models' / model_name
    model = WhisperModel(str(model_root).removeprefix('\\\\?\\'), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    with av.open(str(source)) as container:
        container_origin_seconds = (container.start_time or 0) / av.time_base
        tracks = [{'index': t.index, 'time_base': str(t.time_base), 'start_time': t.start_time,
                   'origin_seconds': float((t.start_time or 0) * t.time_base),
                   'estimated_seconds': float(t.duration * t.time_base) if t.duration else (container.duration or 0) / av.time_base}
                  for t in container.streams if t.type == 'audio']
    pages, coverage = [], []
    total_text_chars = 0
    rate, core, context = 16000, 60, 2

    def progress(data):
        temporary = job / 'progress.next.json'
        temporary.write_text(json.dumps(data), encoding='utf-8')
        os.replace(temporary, job / 'progress.json')

    for track_number, descriptor in enumerate(tracks):
        window_start, actual_end = 0.0, 0.0
        audio = np.zeros((core + context) * rate, dtype=np.float32)
        covered = np.zeros(len(audio), dtype=bool)
        decoded_seconds, gap_seconds, chunks = 0.0, 0.0, 0
        language = None

        def consume(end, final=False):
            nonlocal window_start, audio, covered, decoded_seconds, gap_seconds, chunks, language, total_text_chars
            if (job / 'cancel.request').exists():
                raise RuntimeError('Transcription cancelled; completed chunks remain in the private job journal')
            length = min(len(audio), max(0, round((end - window_start) * rate)))
            core_length = min(core * rate, length)
            if core_length <= 0:
                return
            decoded_seconds += float(covered[:core_length].sum() / rate)
            gap_seconds += float((~covered[:core_length]).sum() / rate)
            key = hashlib.sha256(audio[:length].tobytes() + json.dumps([model_name, descriptor, window_start, core_length, length, language], sort_keys=True).encode()).hexdigest()
            cache = job / f'chunk-{key}.json'
            chunk_pages = []
            chunk_text_chars = 0
            if cache.is_file():
                cached = json.loads(cache.read_text(encoding='utf-8'))
                if cached.get('key') != key:
                    raise ValueError('Invalid transcription checkpoint')
                chunk_pages, language = cached['pages'], cached['language']
                chunk_text_chars = sum(len(page['text']) for page in chunk_pages)
            else:
                if covered[:length].any() and np.any(audio[:length]):
                    segments, info = model.transcribe(audio[:length], language=language, beam_size=3,
                                                     vad_filter=False, word_timestamps=True, condition_on_previous_text=False)
                    if language is None and info.language_probability >= .7:
                        language = info.language
                    for segment in segments:
                        words = [w for w in segment.words or [] if (w.start + w.end) / 2 < core_length / rate]
                        if not words:
                            continue
                        a, b = window_start + words[0].start, window_start + words[-1].end
                        chunk_pages.append({'locator': f'track:{descriptor["index"]}:seconds:{a:.3f}-{b:.3f}',
                                      'start': a, 'end': b, 'track': descriptor['index'],
                                      'text': ''.join(w.word for w in words).strip(),
                                      'language': info.language, 'language_probability': info.language_probability,
                                      'avg_logprob': segment.avg_logprob, 'no_speech_prob': segment.no_speech_prob,
                                      # Decoder diagnostics, not calibrated accuracy: a high compression
                                      # ratio flags repetition loops; temperature > 0 means fallback decoding.
                                      'compression_ratio': segment.compression_ratio, 'temperature': segment.temperature,
                                      'method': f'faster-whisper-{model_name} int8; unverified machine transcript',
                                      'words': [{'start': window_start + w.start, 'end': window_start + w.end,
                                                 'word': w.word, 'probability': w.probability} for w in words]})
                        chunk_text_chars += len(chunk_pages[-1]['text'])
                        if len(chunk_pages) > 100000 or chunk_text_chars > 8_000_000:
                            raise ValueError('Full transcript exceeds the published output limit')
                temporary = cache.with_suffix('.next')
                with temporary.open('w', encoding='utf-8') as output:
                    json.dump({'key': key, 'pages': chunk_pages, 'language': language}, output)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, cache)
            pages.extend(chunk_pages)
            total_text_chars += chunk_text_chars
            if len(pages) > 100000 or total_text_chars > 8_000_000:
                raise ValueError('Full transcript exceeds the published output limit')
            chunks += 1
            progress({'state': 'transcribing', 'track': descriptor['index'], 'track_number': track_number + 1,
                      'track_count': len(tracks), 'processed_seconds': min(end, window_start + core),
                      'estimated_seconds': descriptor['estimated_seconds'], 'segments': len(pages), 'chunks': chunks})
            # Per-chunk files hold the reusable wording. This small journal is
            # progress only and never claims a complete transcript.
            if final or chunks % 10 == 0:
                temporary = job / 'partial.next.json'
                temporary.write_text(json.dumps({'status': 'partial', 'segments': len(pages),
                                                 'track': descriptor['index'], 'chunks': chunks,
                                                 'last_completed_seconds': min(end, window_start + core)}), encoding='utf-8')
                os.replace(temporary, job / 'partial.json')
            if not final:
                audio[:context * rate] = audio[core * rate:]
                covered[:context * rate] = covered[core * rate:]
                audio[context * rate:] = 0
                covered[context * rate:] = False
                window_start += core

        def accept(frame):
            nonlocal actual_end
            if frame.pts is None:
                raise ValueError('Decoded audio lacks timestamps; full coverage cannot be established')
            position = float(frame.pts * frame.time_base) - descriptor['origin_seconds']
            if position < -2 or position > 12 * 3600:
                raise ValueError('Unsupported timestamp discontinuity or recording longer than 12 hours')
            samples = frame.to_ndarray().reshape(-1)
            while position + len(samples) / rate > window_start + core + context:
                offset = round((position - window_start) * rate)
                a, b = max(0, offset), min(len(audio), offset + len(samples))
                if b > a:
                    audio[a:b] = samples[a-offset:b-offset]
                    covered[a:b] = True
                consume(window_start + core + context)
            offset = round((position - window_start) * rate)
            a, b = max(0, offset), min(len(audio), offset + len(samples))
            if b > a:
                audio[a:b] = samples[a-offset:b-offset]
                covered[a:b] = True
            actual_end = max(actual_end, position + len(samples) / rate)

        with av.open(str(source)) as container:
            track = next(t for t in container.streams if t.index == descriptor['index'])
            resampler = av.AudioResampler(format='fltp', layout='mono', rate=rate)
            for frame in container.decode(track):
                for converted in resampler.resample(frame):
                    accept(converted)
            for converted in resampler.resample(None):
                accept(converted)
        # EOF, not metadata duration, defines processed coverage.
        while actual_end - window_start > core:
            consume(actual_end)
        consume(actual_end, final=True)
        coverage.append({**descriptor, 'decoded_to_eof': True, 'actual_end_seconds': actual_end,
                         'decoded_seconds': decoded_seconds, 'gap_seconds': gap_seconds, 'chunks': chunks})
    progress({'state': 'complete', 'track_count': len(tracks), 'segments': len(pages)})
    # Chunk checkpoints only accelerate resuming interrupted work; prune them after a clean finish.
    for checkpoint in job.glob('chunk-*.json'):
        try:
            checkpoint.unlink()
        except OSError:
            pass
    return {'version': 1, 'status': 'complete', 'pages': pages, 'previews': [],
            'metadata': {'scope': 'all_audio_tracks_to_decoder_eof', 'tracks': coverage,
                         'container_origin_seconds': container_origin_seconds,
                         'audio_track_count': len(tracks), 'vad': False, 'model': f'faster-whisper-{model_name}',
                         'sample_rate': rate, 'chunk_seconds': core, 'lookahead_seconds': context,
                         'no_audio_tracks': not tracks},
            'limitations': ['Unreviewed machine transcription; verify names, numbers, faint speech and language against the original.',
                            'All inventoried audio tracks were decoded to EOF. No audio track does not imply no visible interaction.',
                            'Timestamps are relative to each audio track origin; they are not verified wall-clock times.',
                            'Chunk boundaries use two seconds of lookahead and word midpoint selection; boundary words may need correction.',
                            'VAD is disabled; exact digital zero is not sent to speech recognition. Decoder gaps are separately reported.',
                            'No speaker identification, translation, or direct AI listening is implied.']}
