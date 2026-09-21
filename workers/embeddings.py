"""Local, pinned MiniLM retrieval vectors. No network or executable model code."""
from pathlib import Path
import sys


def embed(job: Path, request: dict) -> dict:
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    texts = request.get('texts', [])
    if not 1 <= len(texts) <= 257 or any(not isinstance(t, str) or len(t) > 4000 for t in texts):
        raise ValueError('Embedding requests require 1–257 bounded text passages')
    root = Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'models' / 'minilm'
    tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(root / 'onnx' / 'model_quint8_avx2.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    names = {item.name for item in session.get_inputs()}
    vectors, truncated = [], []
    for start in range(0, len(texts), 16):
        if (job / 'cancel.request').exists():
            raise RuntimeError('Semantic indexing cancelled')
        tokens = tokenizer.encode_batch(texts[start:start + 16])
        inputs = {'input_ids': np.array([t.ids for t in tokens], dtype=np.int64), 'attention_mask': np.array([t.attention_mask for t in tokens], dtype=np.int64), 'token_type_ids': np.array([t.type_ids for t in tokens], dtype=np.int64)}
        output = session.run(None, {k: v for k, v in inputs.items() if k in names})[0]
        mask = inputs['attention_mask'][:, :, None].astype(np.float32)
        pooled = (output * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9)
        vectors.extend(pooled.tolist())
        truncated.extend(bool(t.overflowing) for t in tokens)
    return {'version': 1, 'status': 'complete', 'vectors': vectors, 'truncated': truncated, 'model': 'minilm-1110a243-quint8-avx2-mean256', 'pages': [], 'previews': []}
