#!/usr/bin/env python3
"""
Exporte sentence-transformers/static-similarity-mrl-multilingual-v1 (Apache 2.0)
vers un format binaire léger exploitable en JS pur (sans dépendance runtime).

Format binaire <name>.bin :
  - 4 bytes magic "STV1"
  - uint32le vocab_size (V)
  - uint32le dim (D)
  - uint8 quantized_flag (0 = Float32, 1 = Int8 symétrique par ligne)
  - 3 bytes padding (aligné sur 16 octets)
  - Si quantized_flag == 1 :
      - V * float32le row_scales (scale_i = max(abs(w_i)) / 127)
      - V * D * int8 weights
    Sinon :
      - V * D * float32le weights

Et <name>.vocab.json :
  - { unkToken, clsToken?, lowercase, stripAccents, vocabSize, dim, idToToken (array V), parityCases }
"""

import json
import os
import struct
import time
import numpy as np
import torch
from sentence_transformers import SentenceTransformer

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "../../../../data/search-indexes/mission-semantic"
)
os.makedirs(OUT_DIR, exist_ok=True)


def export_model(dim: int):
    t0 = time.time()
    model = SentenceTransformer(
        "sentence-transformers/static-similarity-mrl-multilingual-v1",
        truncate_dim=dim,
    )
    mod = model[0]
    weight = mod.embedding.weight[:, :dim].detach().cpu().to(torch.float32).numpy()
    vocab_size, d = weight.shape
    tok = mod.tokenizer
    vocab_dict = tok.get_vocab()
    id_to_token = [""] * vocab_size
    for token_str, tid in vocab_dict.items():
        if 0 <= tid < vocab_size:
            id_to_token[tid] = token_str

    # Tests de parité exacts Python -> JS (tokens + vecteurs L2-normalisés)
    test_texts = [
        "Doliprane 1 g comprimé",
        "esoméprazole 40mg",
        "pommade diclofénac",
        "acetaminophen 500 mg",
        "ibuprofene comprime a avaler",
        "méthotrexate per os",
        "medicament metacam chien",
        "AMOXICILLINE/ACIDE CLAVULANIQUE 1 g/125 mg",
    ]
    py_vecs = model.encode(test_texts, normalize_embeddings=True)
    parity_cases = []
    for i, text in enumerate(test_texts):
        enc = tok.encode(text, add_special_tokens=False)
        parity_cases.append({
            "text": text,
            "tokens": enc.tokens,
            "ids": enc.ids,
            "vec": [round(float(x), 6) for x in py_vecs[i]],
        })

    # Export Int8 (symétrique par token) + Float32 (pour 128d seulement, référence compression)
    scales = np.maximum(np.max(np.abs(weight), axis=1), 1e-12) / 127.0
    q_weights = np.clip(np.round(weight / scales[:, None]), -127, 127).astype(np.int8)
    scales_f32 = scales.astype("<f4")

    int8_path = os.path.join(OUT_DIR, f"static_mrl_{dim}d_int8.bin")
    with open(int8_path, "wb") as f:
        f.write(b"STV1")
        f.write(struct.pack("<II B 3s", vocab_size, d, 1, b"\x00\x00\x00"))
        f.write(scales_f32.tobytes())
        f.write(q_weights.tobytes())

    f32_path = None
    if dim == 128:
        f32_path = os.path.join(OUT_DIR, f"static_mrl_{dim}d_f32.bin")
        with open(f32_path, "wb") as f:
            f.write(b"STV1")
            f.write(struct.pack("<II B 3s", vocab_size, d, 0, b"\x00\x00\x00"))
            f.write(weight.astype("<f4").tobytes())

    meta_path = os.path.join(OUT_DIR, f"static_mrl_{dim}d.meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": "sentence-transformers/static-similarity-mrl-multilingual-v1",
                "vocabSize": vocab_size,
                "dim": d,
                "unkToken": "[UNK]",
                "continuingSubwordPrefix": "##",
                "maxInputCharsPerWord": 100,
                "lowercase": True,
                "stripAccents": True,
                "idToToken": id_to_token,
                "parityCases": parity_cases,
            },
            f,
            ensure_ascii=False,
        )

    print(
        f"Exported dim={dim}: int8={os.path.getsize(int8_path)}B"
        + (f", f32={os.path.getsize(f32_path)}B" if f32_path else "")
        + f", meta={os.path.getsize(meta_path)}B in {time.time()-t0:.2f}s"
    )


if __name__ == "__main__":
    export_model(64)
    export_model(128)
