"""Local anonymous speaker turns for one explicit track interval; no identity attribution."""
from pathlib import Path
import math, sys

def diarize(job: Path, request: dict) -> dict:
    import av
    import numpy as np
    import sherpa_onnx as so
    start, end = float(request['start']), float(request['end'])
    track_index = request['track']
    if not all(math.isfinite(v) for v in (start,end)) or not 0 <= start < end or end-start > 600 or not isinstance(track_index,int) or track_index<0:
        raise ValueError('Choose an audio stream index and a finite interval of at most 600 seconds')
    rate=16000
    signal=np.zeros(math.ceil((end-start)*rate),dtype=np.float32)
    covered=np.zeros(len(signal),dtype=bool)
    with av.open(str(job/'input')) as container:
        track=next((t for t in container.streams.audio if t.index==track_index),None)
        if track is None:raise ValueError('Selected stream is not an audio track')
        origin=float((track.start_time or 0)*track.time_base)
        container_origin=(container.start_time or 0)/av.time_base
        container.seek(max(0,int((start+origin)*av.time_base)),backward=True)
        resampler=av.AudioResampler(format='fltp',layout='mono',rate=rate)
        def accept(frame):
            if frame.pts is None:raise ValueError('Missing audio timestamp')
            offset=round((float(frame.pts*frame.time_base)-origin-start)*rate)
            data=frame.to_ndarray().reshape(-1)
            a,b=max(0,offset),min(len(signal),offset+len(data))
            if b>a:
                if covered[a:b].any():raise ValueError('Overlapping timestamps require separate interval analysis')
                signal[a:b]=data[a-offset:b-offset];covered[a:b]=True
        for index,frame in enumerate(container.decode(track)):
            if index>200000:raise ValueError('Decode bound reached')
            if (job/'cancel.request').exists():raise RuntimeError('Speaker analysis cancelled')
            if frame.pts is None:raise ValueError('Missing audio timestamp')
            if float(frame.pts*frame.time_base)-origin>=end:break
            for converted in resampler.resample(frame):accept(converted)
        for converted in resampler.resample(None):accept(converted)
    if not covered.any():raise ValueError('No decoded audio in selected interval')
    root=Path(getattr(sys,'_MEIPASS',Path(__file__).parent))/'models'/'diarization'
    config=so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(root/'model.onnx')),num_threads=2),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=str(root/'embedding.onnx'),num_threads=2),
        clustering=so.FastClusteringConfig(num_clusters=-1,threshold=.5),min_duration_on=.3,min_duration_off=.5)
    if not config.validate():raise ValueError('Diarization model configuration invalid')
    engine=so.OfflineSpeakerDiarization(config)
    def progress(done,total):
        if (job/'cancel.request').exists():raise RuntimeError('Speaker analysis cancelled')
        return 0
    segments=engine.process(signal,callback=progress).sort_by_start_time()
    if (job/'cancel.request').exists():raise RuntimeError('Speaker analysis cancelled')
    turns=[{'start':start+float(s.start),'end':start+float(s.end),'speaker':f'voice_{s.speaker+1}','track':track_index,'review':'unreviewed anonymous cluster'} for s in segments]
    return {'version':1,'status':'complete','previews':[],
            'pages':[{'locator':f'track:{track_index}:seconds:{t["start"]:.3f}-{t["end"]:.3f}','text':t['speaker'],'method':'anonymous local diarization; not speaker identity'} for t in turns],
            'metadata':{'turns':turns,'requested_interval':[start,end],'track_index':track_index,'origin_seconds':origin,'container_origin_seconds':container_origin,'decoded_seconds':float(covered.sum()/rate),'gap_seconds':float((~covered).sum()/rate),'model':'pyannote-segmentation-3.0 + titanet-small; sherpa-onnx-1.13.8','cluster_threshold':.5,'speaker_ids_local_to_this_run':True},
            'limitations':['Anonymous speaker clusters are proposals, not authenticated identities. Labels do not match across runs or recordings.','Noise, overlap, short turns and channel mixing may merge or split speakers. This English embedding model has not been evaluated on this case.','Only the selected audio track interval was decoded; gaps are zero-filled and reported. Verify turns against original playback.']}
