"""
Build the FAISS index over hs_code_master.description_en.

This index powers Path 4 (Reasoner) — when no code or no prefix match is found,
we embed the product description and retrieve the top-K semantically similar
HS codes to pass as candidates to the LLM.

Run (after db/setup.py):
    python db/build_faiss.py

Verify:
    python -c "
    import faiss, json
    idx = faiss.read_index('hs_master_faiss.index')
    codes = json.load(open('hs_codes.json'))
    assert idx.ntotal == len(codes)
    print(f'{idx.ntotal} vectors, dim={idx.d}')
    "

Design notes:
- Model: all-MiniLM-L6-v2 (384-dim, fast, ~80MB).
- Index: IndexFlatIP on L2-normalized vectors → cosine similarity via inner product.
  This gives identical ranking to IndexFlatL2 on normalized vectors but scores in
  [-1, 1] which are easier for the Reasoner to reason about.
- Metadata: hs_codes.json stores the parallel code list; position-indexed.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import sys
from pathlib import Path

# Make `config` importable when running as `python db/build_faiss.py`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config  # noqa: E402

logger = logging.getLogger("clearai.db.build_faiss")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")

EMBEDDING_MODEL = "all-MiniLM-L6-v2"
BATCH_SIZE = 128


def _load_corpus(conn: sqlite3.Connection) -> tuple[list[str], list[str]]:
    """Return parallel lists (codes, texts) ordered by hs_code for determinism."""
    rows = conn.execute(
        """SELECT hs_code, description_en
           FROM hs_code_master
           WHERE description_en IS NOT NULL AND TRIM(description_en) != ''
           ORDER BY hs_code"""
    ).fetchall()
    codes = [r[0] for r in rows]
    texts = [r[1].strip() for r in rows]
    return codes, texts


def main() -> int:
    # Lazy import — keeps startup fast when just running --help etc.
    import faiss
    import numpy as np
    from sentence_transformers import SentenceTransformer

    if not config.DB_PATH.is_file():
        logger.error("Database not found at %s. Run `python db/setup.py` first.", config.DB_PATH)
        return 2

    logger.info("Loading corpus from %s …", config.DB_PATH)
    conn = sqlite3.connect(config.DB_PATH)
    try:
        codes, texts = _load_corpus(conn)
    finally:
        conn.close()
    logger.info("Corpus size: %d HS codes with descriptions", len(codes))

    if not codes:
        logger.error("No rows found in hs_code_master. Did db/setup.py succeed?")
        return 1

    logger.info("Loading embedding model: %s", EMBEDDING_MODEL)
    model = SentenceTransformer(EMBEDDING_MODEL)

    logger.info("Encoding %d descriptions (batch=%d)…", len(texts), BATCH_SIZE)
    embeddings = model.encode(
        texts,
        batch_size=BATCH_SIZE,
        show_progress_bar=True,
        normalize_embeddings=True,   # L2-normalize → IP == cosine
        convert_to_numpy=True,
    ).astype("float32")

    dim = embeddings.shape[1]
    logger.info("Building FAISS IndexFlatIP (dim=%d)…", dim)
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    # Persist
    logger.info("Writing index → %s", config.FAISS_INDEX_PATH)
    faiss.write_index(index, str(config.FAISS_INDEX_PATH))

    logger.info("Writing codes list → %s", config.FAISS_CODES_PATH)
    with open(config.FAISS_CODES_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": EMBEDDING_MODEL,
                "dim": dim,
                "count": len(codes),
                "codes": codes,
            },
            f,
            ensure_ascii=False,
        )

    # Self-test: embed a known description, search, expect the exact code first
    sample_idx = min(100, len(codes) - 1)
    query_text = texts[sample_idx]
    expected_code = codes[sample_idx]
    q = model.encode([query_text], normalize_embeddings=True, convert_to_numpy=True).astype("float32")
    scores, ids = index.search(q, k=5)
    got_code = codes[ids[0][0]]
    got_score = float(scores[0][0])
    if got_code != expected_code:
        logger.warning(
            "Self-test: query %r → expected %s, got %s (score %.3f)",
            query_text[:60], expected_code, got_code, got_score,
        )
    else:
        logger.info(
            "Self-test OK: query %r → %s (score %.3f)",
            query_text[:60], got_code, got_score,
        )

    logger.info("=" * 60)
    logger.info("FAISS build complete.")
    logger.info("  Vectors    : %d", index.ntotal)
    logger.info("  Dimension  : %d", dim)
    logger.info("  Index file : %s", config.FAISS_INDEX_PATH)
    logger.info("  Codes file : %s", config.FAISS_CODES_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
