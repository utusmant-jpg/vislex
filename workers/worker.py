"""One-job, no-network document/image worker. Only the native AppContainer broker launches this.

Output is untrusted until validated by Rust. No database access or arbitrary code execution.
"""
from __future__ import annotations
import ctypes
import json
import math
import os
from pathlib import Path
import sys

MAX_TEXT = 8_000_000
WORKER_PROTOCOL = 2

def is_appcontainer() -> bool:
    if sys.platform != 'win32':
        return False
    from ctypes import wintypes
    token = wintypes.HANDLE()
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        return False
    try:
        result, size = wintypes.DWORD(), wintypes.DWORD()
        return bool(advapi.GetTokenInformation(token, 29, ctypes.byref(result), 4, ctypes.byref(size)) and result.value)
    finally:
        kernel.CloseHandle(token)

def process(job: Path, request: dict) -> dict:
    source = Path(request['source_lease']) if request.get('source_lease') else job / 'input'
    kind = request['kind']
    pages: list[dict] = []
    notes: list[str] = []
    metadata: dict = {}
    previews: list[dict] = []
    if kind == 'office_image':
        import zipfile
        from io import BytesIO
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 60_000_000
        with zipfile.ZipFile(source) as package:
            names = sorted(n for n in package.namelist() if n.startswith(('word/media/', 'ppt/media/', 'xl/media/', 'Pictures/')) and not n.endswith('/'))
            index = request.get('image_index')
            if not isinstance(index, int) or not 0 <= index < len(names):
                raise ValueError('Image index is outside the Office package')
            entry = package.getinfo(names[index])
            if entry.file_size > 30 * 1024 * 1024:
                raise ValueError('Office image exceeds bounded decode limit')
            with Image.open(BytesIO(package.read(entry))) as image:
                if getattr(image, 'n_frames', 1) > 1:
                    raise ValueError('Embedded multipage image requires a separate frame path')
                oriented = ImageOps.exif_transpose(image)
                oriented.thumbnail((2400, 2400))
                oriented.convert('RGB').save(job / 'office-image.jpg', quality=92)
                metadata = {'package_part': names[index], 'image_index': index, 'original_size': list(image.size), 'output_size': list(oriented.size)}
        return {'version': 1, 'status': 'complete', 'pages': [], 'metadata': metadata, 'limitations': ['Immutable derivative of an embedded Office image; page placement and surrounding layout are not established.'], 'previews': [{'path': 'office-image.jpg', **metadata}]}
    if kind in ('video_ocr', 'video_overview'):
        from video_discovery import discover
        return discover(job, request)
    if kind == 'email':
        from email_extract import extract
        return extract(job, request)
    if kind == 'media_clip':
        from media_clip import clip
        return clip(job, request)
    if kind == 'diarization':
        from diarization import diarize
        return diarize(job, request)
    if kind == 'embeddings':
        from embeddings import embed
        return embed(job, request)
    if kind == 'document_export':
        from document_export import export
        return export(job, request)
    elif kind == 'redaction':
        from redaction import redact
        return redact(job, request)
    elif kind == 'media_inventory':
        import av
        with av.open(str(source)) as container:
            streams = []
            for stream in container.streams:
                descriptor = {'index': stream.index, 'type': stream.type, 'time_base': str(stream.time_base), 'start_pts': str(stream.start_time) if stream.start_time is not None else None, 'duration_pts': str(stream.duration) if stream.duration is not None else None, 'duration_seconds': float(stream.duration * stream.time_base) if stream.duration is not None and stream.time_base else None, 'metadata': dict(stream.metadata)}
                streams.append(descriptor)
                pages.append({'locator': f'stream:{stream.index}', 'text': json.dumps(descriptor), 'method': 'container inventory; not content inspection'})
            metadata = {'streams': streams, 'container_origin_seconds': (container.start_time or 0) / av.time_base, 'container_duration_seconds': container.duration / av.time_base if container.duration is not None else None, 'container_metadata': dict(container.metadata), 'coverage': {'inventoried': True, 'model_inspected': False}}
        notes = ['Container metadata is not proof of capture time. Transcription and visual inspection have separate coverage.']
        return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'limitations': notes, 'previews': previews}
    elif kind == 'sound_events':
        from sound_events import scan
        return scan(source, request)
    if kind == 'full_audio':
        from full_audio import transcribe
        return transcribe(job, source, request.get('asr_model', 'tiny'))
    if kind == 'probe':
        import socket
        metadata['appcontainer'] = is_appcontainer()
        for action in ['read', 'write']:
            try:
                target = Path(request['outside_path'])
                if action == 'read':
                    target.read_bytes()
                else:
                    target.write_text('SANDBOX_FAILURE', encoding='utf-8')
                metadata[action + '_denied'] = False
            except PermissionError:
                metadata[action + '_denied'] = True
        try:
            with socket.create_connection(('127.0.0.1', request['port']), timeout=1):
                metadata['network_denied'] = False
        except OSError:
            metadata['network_denied'] = True
    elif kind == 'playback':
        import av
        from fractions import Fraction
        with av.open(str(source)) as incoming, av.open(str(job / 'playback.mp4'), 'w', options={'movflags': '+faststart'}) as outgoing:
            videos = list(incoming.streams.video)
            if not videos:
                raise ValueError('No video track is available')
            video = videos[0]
            target = outgoing.add_stream('libx264', rate=video.average_rate or 30)
            target.width = video.width + video.width % 2
            target.height = video.height + video.height % 2
            target.pix_fmt = 'yuv420p'
            target.options = {'preset': 'veryfast', 'crf': '20'}
            target.time_base = Fraction(1, 90000)
            target.codec_context.time_base = Fraction(1, 90000)
            target.codec_context.thread_count = 2
            audio_targets = {}
            for track in incoming.streams.audio:
                output = outgoing.add_stream('aac', rate=track.codec_context.sample_rate or 48000)
                output.layout = track.codec_context.layout.name
                audio_targets[track.index] = output
            origin = Fraction(incoming.start_time or 0, av.time_base)
            frames = 0
            for packet in incoming.demux([video, *incoming.streams.audio]):
                for frame in packet.decode():
                    output = target if packet.stream.index == video.index else audio_targets[packet.stream.index]
                    if frame.pts is not None:
                        timestamp = frame.pts * frame.time_base - origin
                        if packet.stream.index == video.index:
                            frame = frame.reformat(width=target.width, height=target.height, format='yuv420p')
                            frame.time_base = Fraction(1, 90000)
                            frame.pts = round(timestamp / frame.time_base)
                            frames += 1
                        else:
                            frame.pts = round(timestamp / frame.time_base)
                    for encoded in output.encode(frame):
                        outgoing.mux(encoded)
            for output in [target, *audio_targets.values()]:
                for encoded in output.encode():
                    outgoing.mux(encoded)
        metadata = {'kind': 'playback', 'source_origin_seconds': float(origin), 'player_origin_seconds': 0.0, 'video_frames': frames, 'audio_tracks': len(audio_targets), 'original_preserved': True}
        previews.append({'path': 'playback.mp4', 'mime': 'video/mp4', **metadata})
        notes = ['H.264/AAC playback derivative. Use original decoded frames for exact-frame citations.', 'The first video track and all audio tracks are included; browser track selection depends on the installed viewer.']
    elif kind == 'audio':
        model_name = request.get('asr_model', 'tiny')
        if model_name not in ('tiny', 'small'):
            raise ValueError('Unsupported local speech profile')
        import av
        import numpy as np
        from faster_whisper import WhisperModel
        start, end = float(request.get('start', 0)), float(request.get('end', 30))
        if not (0 <= start < end and end - start <= 60):
            raise ValueError('Choose a transcription interval no longer than 60 seconds')
        with av.open(str(source)) as container:
            tracks = [s for s in container.streams if s.type == 'audio']
            if not tracks:
                raise ValueError('No audio stream exists; no speech conclusion can be made')
            track_index = request.get('track')
            if track_index is None:
                track = tracks[0]
            else:
                track = next((s for s in tracks if s.index == track_index), None)
            if track is None:
                raise ValueError('Audio track index does not exist')
            origin = float((track.start_time or 0) * track.time_base)
            container.seek(max(0, int((start + origin) * av.time_base)), backward=True)
            resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
            audio = np.zeros(int((end-start)*16000), dtype=np.float32)
            covered = np.zeros(len(audio), dtype=bool)
            decoded = 0
            for frame in container.decode(track):
                decoded += 1
                if decoded > 100000:
                    raise ValueError('Audio decode limit exceeded')
                if frame.pts is None:
                    raise ValueError('Audio timestamps missing; interval cannot be verified')
                position = float(frame.pts * frame.time_base) - origin
                if position >= end:
                    break
                for resampled in resampler.resample(frame):
                    if resampled.pts is None:
                        raise ValueError('Resampled timestamp missing')
                    position = float(resampled.pts * resampled.time_base) - origin
                    samples = resampled.to_ndarray().reshape(-1)
                    offset = round((position-start)*16000)
                    a, b = max(0, offset), min(len(audio), offset+len(samples))
                    if b > a:
                        audio[a:b] = samples[a-offset:b-offset]
                        covered[a:b] = True
            if not covered.any():
                raise ValueError('No decodable audio in requested interval')
            metadata = {'track_index': track.index, 'audio_tracks': [{'index': s.index, 'time_base': str(s.time_base), 'start_time': s.start_time} for s in tracks], 'requested_interval': [start, end], 'origin_seconds': origin, 'decoded_seconds': float(covered.sum()/16000), 'gap_seconds': float((~covered).sum()/16000), 'vad': False, 'model': f'faster-whisper-{model_name}', 'compute_type': 'int8', 'sample_rate': 16000, 'channels': 'derived mono'}
        model_root = Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'models' / model_name
        if not (model_root / 'model.bin').exists():
            raise ValueError('Local transcription model is not installed')
        # CTranslate2 appends forward-slash paths; Windows verbatim-path prefixes reject those.
        model_path = str(model_root).removeprefix('\\\\?\\')
        model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)
        segments, info = model.transcribe(audio, beam_size=3, vad_filter=False, word_timestamps=True, condition_on_previous_text=False)
        metadata['language'] = info.language
        metadata['language_probability'] = info.language_probability
        for segment in segments:
            pages.append({'locator': f'track:{metadata["track_index"]}:seconds:{start+segment.start:.3f}-{start+segment.end:.3f}', 'text': segment.text, 'method': f'faster-whisper-{model_name} int8; unverified machine transcript', 'avg_logprob': segment.avg_logprob, 'no_speech_prob': segment.no_speech_prob, 'compression_ratio': segment.compression_ratio, 'temperature': segment.temperature, 'words': [{'start': start+w.start, 'end': start+w.end, 'word': w.word, 'probability': w.probability} for w in segment.words or []]})
        notes = ['Unverified machine transcription using the selected local multilingual model; check names, numbers, and faint speech against original audio.', 'Only the selected audio track and interval were decoded. Other tracks remain unprocessed.', 'VAD is disabled. Decoder gaps are accounted separately and zero-filled for timing; silence does not establish absence of events.', 'Transcription is not direct audio understanding, speaker identity, or legal interpretation.']
    elif kind == 'video':
        import av
        if request.get('operation') == 'frame_at':
            target = float(request.get('target', -1))
            direction = request.get('direction')
            if not math.isfinite(target) or target < 0 or direction not in ('previous', 'next'):
                raise ValueError('Invalid exact frame request')
            leased_source = Path(request['source_lease'])
            with av.open(str(leased_source)) as container:
                video = next((s for s in container.streams if s.type == 'video'), None)
                if video is None:
                    raise ValueError('No decodable video stream')
                origin = float((video.start_time or 0) * video.time_base)
                seek_before = max(0., target - (30. if direction == 'previous' else 2.))
                container.seek(max(0, int((seek_before + origin) * av.time_base)), backward=True)
                selected = None
                decoded = 0
                for frame in container.decode(video):
                    decoded += 1
                    if decoded > 10000:
                        raise ValueError('Exact frame decode limit reached')
                    if frame.pts is None:
                        continue
                    relative = float(frame.pts * frame.time_base) - origin
                    if direction == 'next' and relative > target + 1e-7:
                        selected = (frame, relative)
                        break
                    if direction == 'previous':
                        if relative < target - 1e-7:
                            selected = (frame, relative)
                        else:
                            break
                if selected is None:
                    raise ValueError('No adjacent decoded frame in the supported seek window')
                frame, relative = selected
                image = frame.to_image()
                original_size = list(image.size)
                image.thumbnail((1920, 1080))
                image.save(job / 'exact-frame.jpg', quality=92)
                previews = [{'path': 'exact-frame.jpg', 'pts': frame.pts, 'time_base': str(frame.time_base), 'source_relative_seconds': relative, 'presentation_seconds': float(frame.pts * frame.time_base), 'original_size': original_size, 'output_size': list(image.size)}]
                metadata = {'video_stream': video.index, 'origin_seconds': origin, 'requested_time': target, 'direction': direction, 'frames_decoded': decoded, 'selection': 'adjacent decoded presentation frame'}
            notes = ['Exact adjacent decoded frame PTS from the original recording. The JPEG is a resized derivative; original bytes are preserved.', 'Audio and intervening activity were not inspected.']
            return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'limitations': notes, 'previews': previews}
        if request.get('operation') == 'sheet':
            try:
                start = float(request.get('start', 0))
                end = float(request.get('end', 10))
                interval = float(request.get('interval', 1))
            except (TypeError, ValueError):
                raise ValueError('Contact sheet start, end, and interval must be numbers')
            cols, rows, tile_width = request.get('cols', 3), request.get('rows', 3), request.get('tile_width', 640)
            if not (isinstance(cols, int) and not isinstance(cols, bool) and 2 <= cols <= 4):
                raise ValueError('Contact sheet columns must be an integer from 2 to 4')
            if not (isinstance(rows, int) and not isinstance(rows, bool) and 2 <= rows <= 4):
                raise ValueError('Contact sheet rows must be an integer from 2 to 4')
            if not (isinstance(tile_width, int) and not isinstance(tile_width, bool) and 240 <= tile_width <= 960):
                raise ValueError('Contact sheet tile width must be an integer from 240 to 960')
            if not (math.isfinite(start) and math.isfinite(end) and math.isfinite(interval) and 0 <= start < end and end - start <= 180 and interval >= 0.5):
                raise ValueError('Choose a 0-180 second window with an interval of at least 0.5 seconds')
            if (end - start) / interval > 64:
                raise ValueError('Contact sheet exceeds the 64 sampled frame limit; increase the interval or shorten the window')
            tile_height = round(tile_width * 9 / 16)
            targets = [start + index * interval for index in range(max(1, math.ceil((end - start) / interval - 1e-9)))]
            with av.open(str(source)) as container:
                streams = [{'index': s.index, 'type': s.type, 'time_base': str(s.time_base), 'start_time': s.start_time} for s in container.streams]
                video = next((s for s in container.streams if s.type == 'video'), None)
                if video is None:
                    raise ValueError('No decodable video stream')
                origin = float((video.start_time or 0) * video.time_base)
                container.seek(max(0, int((start + origin) * av.time_base)), backward=True)
                samples = []
                decoded = 0
                for frame in container.decode(video):
                    decoded += 1
                    if decoded > 20000:
                        raise ValueError('Decode limit reached before requested interval completed')
                    if frame.pts is None:
                        continue
                    presentation = float(frame.pts * frame.time_base)
                    relative = presentation - origin
                    if relative >= end:
                        break
                    if len(samples) >= len(targets):
                        break
                    if relative + 1e-7 < targets[len(samples)]:
                        continue
                    image = frame.to_image()
                    original_size = list(image.size)
                    image.thumbnail((tile_width, tile_height))
                    samples.append({'image': image, 'pts': frame.pts, 'time_base': str(frame.time_base), 'source_relative_seconds': relative, 'presentation_seconds': presentation, 'original_size': original_size})
                metadata = {'streams': streams, 'video_stream': video.index, 'origin_seconds': origin, 'requested_interval': [start, end], 'sample_interval': interval, 'frames_decoded': decoded, 'sampled_frames': len(samples), 'operation': 'sheet'}
            from PIL import Image, ImageDraw, ImageFont
            try:
                font = ImageFont.load_default(size=18)
            except TypeError:
                font = ImageFont.load_default()

            def stamp(seconds: float) -> str:
                seconds = round(max(0.0, seconds), 1)
                hours = int(seconds // 3600)
                minutes = int((seconds - hours * 3600) // 60)
                remainder = seconds - hours * 3600 - minutes * 60
                return f'{hours}:{minutes:02d}:{remainder:04.1f}' if hours else f'{minutes:02d}:{remainder:04.1f}'

            per_sheet = cols * rows
            previews = []
            for sheet_index in range(math.ceil(len(samples) / per_sheet)):
                canvas = Image.new('RGB', (cols * tile_width, rows * tile_height), 'black')
                tiles = []
                for position in range(per_sheet):
                    global_index = sheet_index * per_sheet + position
                    if global_index >= len(samples):
                        break
                    sample = samples[global_index]
                    tile = Image.new('RGB', (tile_width, tile_height), 'black')
                    tile.paste(sample['image'], ((tile_width - sample['image'].width) // 2, (tile_height - sample['image'].height) // 2))
                    label = f'#{global_index} {stamp(sample["source_relative_seconds"])}'
                    overlay = Image.new('RGBA', tile.size, (0, 0, 0, 0))
                    draw = ImageDraw.Draw(overlay)
                    left, top, right, bottom = draw.textbbox((4, 3), label, font=font)
                    draw.rectangle((0, 0, right + 4, bottom + 3), fill=(0, 0, 0, 170))
                    draw.text((4, 3), label, fill=(255, 255, 255, 255), font=font)
                    canvas.paste(Image.alpha_composite(tile.convert('RGBA'), overlay).convert('RGB'), ((position % cols) * tile_width, (position // cols) * tile_height))
                    tiles.append({'index': global_index, 'tile': position, 'pts': sample['pts'], 'time_base': sample['time_base'], 'source_relative_seconds': sample['source_relative_seconds'], 'presentation_seconds': sample['presentation_seconds'], 'original_size': sample['original_size']})
                filename = f'sheet-{sheet_index:03d}.jpg'
                canvas.save(job / filename, quality=85)
                previews.append({'path': filename, 'sheet_index': sheet_index, 'cols': cols, 'rows': rows, 'tile_width': tile_width, 'tile_height': tile_height, 'output_size': [canvas.width, canvas.height], 'tiles': tiles})
            notes = ['Contact sheet tiles are reduced-resolution derivatives; original frames remain the authoritative source.', 'Gaps between sampled frames were not inspected.', 'Audio was not inspected.', 'No identity or presence conclusion is established by a contact sheet.']
            return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'limitations': notes, 'previews': previews}
        start, end = float(request.get('start', 0)), float(request.get('end', 10))
        interval = float(request.get('interval', 1))
        if not (0 <= start < end and end - start <= 30 and interval >= 0.1 and (end-start)/interval <= 24):
            raise ValueError('Choose a 0–30 second interval with at most 24 sampled frames')
        with av.open(str(source)) as container:
            streams = [{'index': s.index, 'type': s.type, 'time_base': str(s.time_base), 'start_time': s.start_time} for s in container.streams]
            video = next((s for s in container.streams if s.type == 'video'), None)
            if video is None:
                raise ValueError('No decodable video stream')
            origin = float((video.start_time or 0) * video.time_base)
            container.seek(max(0, int((start + origin) * av.time_base)), backward=True)
            next_sample = start
            decoded = 0
            for frame in container.decode(video):
                decoded += 1
                if decoded > 10000:
                    raise ValueError('Decode limit reached before requested interval completed')
                if frame.pts is None:
                    continue
                presentation = float(frame.pts * frame.time_base)
                relative = presentation - origin
                if relative >= end:
                    break
                if relative + 1e-7 < next_sample:
                    continue
                image = frame.to_image()
                original_size = list(image.size)
                image.thumbnail((1920, 1080))
                filename = f'frame-{len(previews):03d}.jpg'
                image.save(job / filename, quality=92)
                previews.append({'path': filename, 'pts': frame.pts, 'time_base': str(frame.time_base), 'source_relative_seconds': relative, 'presentation_seconds': presentation, 'original_size': original_size, 'output_size': list(image.size)})
                next_sample += interval
                if len(previews) >= 24:
                    break
            metadata = {'streams': streams, 'video_stream': video.index, 'origin_seconds': origin, 'requested_interval': [start, end], 'sample_interval': interval, 'frames_decoded': decoded, 'sampled_frames': len(previews)}
        notes = ['Ordered sampled frames with actual decoder PTS; gaps between samples were not visually inspected.', 'Frames may be resized to fit 1920x1080. Originals are preserved. Audio was not inspected.', 'No object presence/absence or identity conclusion is established by decoding.']
    elif kind == 'pdf_probe':
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(str(Path(request['source_lease']))) as document:
            count = len(document)
            if count < 1:
                raise ValueError('PDF has no physical pages')
            first = document[0]
            metadata = {'page_count': count, 'first_page_size_points': list(first.get_size()), 'numbering': 'physical PDF pages, starting at 1; printed labels may differ'}
            first.close()
        notes = ['Page count and geometry are metadata only; no page content was reviewed.']
    elif kind == 'pdf_page':
        import pypdfium2 as pdfium
        number = int(request.get('page', 1))
        with pdfium.PdfDocument(str(Path(request['source_lease']))) as document:
            if not 1 <= number <= len(document):
                raise ValueError('PDF page is outside the document')
            page = document[number - 1]
            try:
                width, height = page.get_size()
                scale = min(2.0, 2400/max(width, height))
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert('RGB')
                    image.save(job / 'pdf-page.jpg', quality=94)
                finally:
                    bitmap.close()
                metadata = {'page': number, 'page_count': len(document), 'page_size_points': [width, height], 'render_scale': scale, 'output_size': list(image.size)}
                previews.append({'path': 'pdf-page.jpg', **metadata})
            finally:
                page.close()
        notes = ['Rendered derivative of the physical PDF page. Printed/Bates labels may differ from the page index.', 'No OCR or interpretation is implied by rendering. Annotations and hidden document structures require separate review.']
    elif kind == 'pdf':
        from pypdf import PdfReader
        reader = PdfReader(source, strict=True)
        if reader.is_encrypted:
            raise ValueError('Password-protected PDF: extraction unavailable')
        if len(reader.pages) > 2000:
            raise ValueError('More than 2,000 PDF pages; split processing is required')
        metadata['embedded_objects'] = len(reader.attachments)
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ''
            pages.append({'locator': f'page:{number}', 'text': text, 'method': 'pypdf native text'})
            for index, annotation in enumerate(page.get('/Annots', [])):
                annotation = annotation.get_object()
                content = str(annotation.get('/Contents', ''))
                if content:
                    pages.append({'locator': f'page:{number}:annotation:{index}', 'text': content, 'method': 'PDF annotation contents; declared authors are not authenticated'})
            if sum(len(p['text']) for p in pages) > MAX_TEXT:
                raise ValueError('Extracted text limit reached; no complete extraction published')
        if request.get('operation') == 'automatic':
            from automatic_ocr import pdf_pages
            for unit in pdf_pages(source):
                pages.append(unit)
                if sum(len(p['text']) for p in pages) > MAX_TEXT:
                    raise ValueError('OCR text limit reached; no complete extraction published')
            metadata['coverage'] = {'native_pages': len(reader.pages), 'ocr_pages': len(reader.pages), 'model_inspected': False}
            notes = ['Native text and OCR remain separate units. OCR may misread text; raw scores are not probabilities.', 'Every physical page was rendered for OCR. Handwriting, annotations, attachments and hidden structures require review.']
        else:
            notes = ['Native text only; image regions and handwriting have not been OCR-processed.', 'Attachments, annotations, and visual layout require separate review.']
    elif kind == 'image':
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 60_000_000
        with Image.open(source) as image:
            metadata = {'format': image.format, 'width': image.width, 'height': image.height, 'frames': getattr(image, 'n_frames', 1), 'exif_raw': {str(k): str(v)[:2048] for k, v in image.getexif().items()}}
            if request.get('operation') == 'render_image_frame':
                frame = request.get('frame')
                if not isinstance(frame, int) or not 0 <= frame < metadata['frames']:
                    raise ValueError('Image frame is outside the original')
                image.seek(frame)
                metadata['frame_index'] = frame
            oriented = ImageOps.exif_transpose(image)
            if request.get('crop'):
                x, y, width, height = request['crop']
                if not (all(isinstance(v, int) for v in [x, y, width, height]) and x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= oriented.width and y + height <= oriented.height):
                    raise ValueError('Crop is outside the orientation-corrected image')
                oriented = oriented.crop((x, y, x + width, y + height))
                metadata['crop'] = [x, y, width, height]
            oriented.convert('RGB').save(job / 'preview.jpg', quality=92)
            previews.append({'path': 'preview.jpg', **metadata})
        if request.get('operation') == 'automatic':
            from automatic_ocr import image_pages
            pages.extend(image_pages(source))
            metadata['coverage'] = {'ocr_frames': len(pages), 'image_frames': metadata['frames'], 'model_inspected': False}
            notes = ['All image frames were passed through local OCR. Raw scores are not probabilities; handwriting and small text can be missed.', 'OCR is not visual scene understanding or identity attribution. Preview displays the first frame.']
        else:
            notes = ['Preview uses EXIF orientation. Original bytes and metadata are preserved.', 'No OCR, identity attribution, or visual understanding is implied. Multipage images require page-by-page review.']
    elif kind == 'docx':
        from docx_extract import extract as extract_docx
        extracted = extract_docx(source)
        pages, notes = extracted['pages'], extracted['notes']
        metadata.update(extracted['metadata'])
    elif kind == 'pptx':
        from pptx_extract import extract as extract_pptx
        extracted = extract_pptx(source)
        pages, notes = extracted['pages'], extracted['notes']
        metadata.update(extracted['metadata'])
    elif kind == 'odt':
        import zipfile
        import xml.etree.ElementTree as ET
        import re
        with zipfile.ZipFile(source) as package:
            names = ['content.xml']
            if sum(package.getinfo(n).file_size for n in names) > 32 * 1024 * 1024:
                raise ValueError('Document XML exceeds extraction limit')
            for name in names:
                root = ET.fromstring(package.read(name))
                units = [node for node in root.iter() if node.tag in ('{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p', '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}h', '{http://schemas.openxmlformats.org/drawingml/2006/main}p')]
                for index, node in enumerate(units, 1):
                    pages.append({'locator': f'{name}:paragraph:{index}', 'text': ''.join(node.itertext()), 'method': 'document-xml'})
        notes = ['Text preview only; layout, images, comments, embedded files and tracked changes are not rendered. Original file is preserved.']
    elif kind == 'xlsx':
        from openpyxl import load_workbook
        # Context managers keep both handles closed even when a corrupt workbook raises mid-read.
        with source.open('rb') as formulas_file, source.open('rb') as cached_file:
            formulas = load_workbook(formulas_file, read_only=True, data_only=False, keep_links=False)
            cached = load_workbook(cached_file, read_only=True, data_only=True, keep_links=False)
            from xlsx_hidden import hidden_structure, summary
            structure = {entry['name']: entry for entry in hidden_structure(source)}
            count = 0
            total = len(formulas.sheetnames)
            for position, sheet in enumerate(formulas, 1):
                visibility = structure.get(sheet.title, {'name': sheet.title, 'state': sheet.sheet_state, 'hidden_rows': [], 'hidden_columns': [], 'hidden_rows_truncated': False})
                pages.append({'locator': f'sheet:{sheet.title}', 'text': summary(visibility, position, total), 'method': 'xlsx workbook structure'})
                cached_rows = iter(cached[sheet.title].iter_rows())
                for row in sheet.iter_rows():
                    values = next(cached_rows, ())
                    for column, cell in enumerate(row):
                        if cell.value is None:
                            continue
                        count += 1
                        if count > 100_000:
                            raise ValueError('Workbook exceeds the 100,000 populated-cell processing limit')
                        value = cell.value
                        text = str(value)
                        if cell.data_type == 'f':
                            text += '\nCached value: ' + str(values[column].value if column < len(values) else None)
                        pages.append({'locator': f'sheet:{sheet.title}!{cell.coordinate}', 'text': text, 'method': 'openpyxl read-only', 'sheet_state': sheet.sheet_state})
            formulas.close()
            cached.close()
            metadata['sheets'] = list(structure.values())
        notes = ['Formulas are not executed. Cached values may be stale or absent.', 'Each sheet unit states hidden or very hidden sheets and hidden rows and columns as declared in the file; cells in them are still listed. Styles, filters and conditional formatting are not reviewed.']
    else:
        raise ValueError('Unsupported processor kind')
    if sum(len(p['text']) for p in pages) > MAX_TEXT:
        raise ValueError('Extracted text exceeds the allowed limit')
    if kind in ('docx', 'pptx', 'xlsx', 'odt'):
        import zipfile
        with zipfile.ZipFile(source) as package:
            names = package.namelist()
            metadata['image_parts'] = sum(n.startswith(('word/media/', 'ppt/media/', 'xl/media/', 'Pictures/')) and not n.endswith('/') for n in names)
            metadata['chart_parts'] = sum(n.startswith(('word/charts/', 'ppt/charts/', 'xl/charts/')) and n.endswith('.xml') for n in names)
    return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'limitations': notes, 'previews': previews}

def json_safe(value):
    """Recursively convert values json.dumps cannot encode (bytes, sets, NaN, arbitrary objects) into safe strings."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return bytes(value).decode('utf-8', errors='replace')
        except Exception:
            return repr(value)
    if isinstance(value, dict):
        safe = {}
        for key, item in value.items():
            key = json_safe(key)
            if not isinstance(key, (str, int, float, bool)):
                key = repr(key)
            safe[key] = json_safe(item)
        return safe
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return '{' + ', '.join(repr(item) for item in sorted(value, key=repr)) + '}'
    try:
        return repr(value)
    except Exception:
        return '<unrepresentable>'

def write_result(job: Path, result: dict) -> None:
    """Publish result.json; if serialization fails, Rust still receives a failed diagnostic."""
    output = job / 'result.json'
    try:
        payload = dict(result)
        if 'protocol' not in payload:
            payload['protocol'] = WORKER_PROTOCOL
        output.write_text(json.dumps(json_safe(payload), ensure_ascii=False), encoding='utf-8')
    except Exception as exc:
        output.write_text(json.dumps({'version': 1, 'protocol': WORKER_PROTOCOL, 'status': 'failed', 'error': repr(exc)[:2000]}, ensure_ascii=False), encoding='utf-8')

def main() -> None:
    if not is_appcontainer():
        raise SystemExit('Refusing to process evidence outside Windows AppContainer')
    job = Path(sys.argv[1]).resolve()
    # Keep a crash trace inside the job directory so import/native failures leave evidence for Rust.
    try:
        crash_log = (job / 'stderr.log').open('w', encoding='utf-8', errors='replace')
    except OSError:
        crash_log = None
    if crash_log is not None:
        sys.stderr = crash_log

        def log_uncaught(exc_type, exc_value, exc_traceback):
            import traceback
            crash_log.write(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)))
            crash_log.flush()

        sys.excepthook = log_uncaught
    try:
        request = json.loads((job / 'request.json').read_text(encoding='utf-8'))
        result = process(job, request)
    except Exception as exc:
        result = {'version': 1, 'status': 'failed', 'error': str(exc)[:2000]}
    write_result(job, result)
    if crash_log is not None:
        crash_log.flush()

if __name__ == '__main__':
    main()
