#!/usr/bin/env python3
"""
Build a local Hawza SQLite + FTS5 knowledge database.

Supported source types:
  .pdf, .txt, .md, .html, .htm, .json

Run from repository root:
  python knowledge/build/build_knowledge.py

Optional:
  python knowledge/build/build_knowledge.py \
      --manifest knowledge/manifest.json \
      --sources knowledge/sources \
      --output knowledge/output/hawza_knowledge.sqlite
"""

from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata
from typing import Iterable, Iterator, Optional

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


ARABIC_DIACRITICS = re.compile(
    r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]"
)
WHITESPACE = re.compile(r"\s+")


class TextHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.parts.append(data)

    def text(self) -> str:
        return "\n".join(self.parts)


def clean_text(value: str) -> str:
    value = html.unescape(value)
    value = value.replace("\u00ad", "")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for line in value.splitlines():
        line = WHITESPACE.sub(" ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines).strip()


def normalize_for_search(value: str) -> str:
    """
    Search-only normalization. Original text remains untouched in `text`.
    """
    value = unicodedata.normalize("NFKC", value)
    value = ARABIC_DIACRITICS.sub("", value)
    value = value.replace("ـ", "")
    translation = str.maketrans({
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
        "ى": "ي",
        "ؤ": "و",
        "ئ": "ي",
    })
    value = value.translate(translation)
    value = WHITESPACE.sub(" ", value).strip().lower()
    return value


def stable_id(*parts: str) -> str:
    raw = "\x1f".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def paragraph_chunks(
    text: str,
    target_chars: int,
    overlap_chars: int,
    min_chars: int,
) -> list[str]:
    text = clean_text(text)
    if not text:
        return []

    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    chunks: list[str] = []
    current = ""

    for p in paragraphs:
        candidate = p if not current else current + "\n" + p
        if len(candidate) <= target_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)

        # Very long single paragraph: hard split.
        if len(p) > target_chars:
            start = 0
            step = max(1, target_chars - overlap_chars)
            while start < len(p):
                piece = p[start:start + target_chars].strip()
                if len(piece) >= min_chars:
                    chunks.append(piece)
                start += step
            current = ""
        else:
            current = p

    if current and len(current) >= min_chars:
        chunks.append(current)

    # Add textual overlap between ordinary chunks when useful.
    if overlap_chars > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            tail = chunks[i - 1][-overlap_chars:].strip()
            combined = (tail + "\n" + chunks[i]).strip() if tail else chunks[i]
            overlapped.append(combined)
        chunks = overlapped

    return chunks


def extract_pdf(path: Path) -> Iterator[tuple[Optional[int], str]]:
    if fitz is None:
        raise RuntimeError(
            "PyMuPDF is required for PDF extraction. "
            "Install: pip install -r knowledge/build/requirements.txt"
        )

    doc = fitz.open(path)
    try:
        for idx, page in enumerate(doc):
            text = clean_text(page.get_text("text"))
            if text:
                yield idx + 1, text
    finally:
        doc.close()


def extract_text_file(path: Path) -> Iterator[tuple[Optional[int], str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    text = clean_text(text)
    if text:
        yield None, text


def extract_html_file(path: Path) -> Iterator[tuple[Optional[int], str]]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    parser = TextHTMLParser()
    parser.feed(raw)
    text = clean_text(parser.text())
    if text:
        yield None, text


def flatten_json_strings(obj, path: str = "") -> Iterator[tuple[str, str]]:
    """
    Conservative JSON extraction:
    - emits string values with their JSON key path
    - does not attempt to infer religious metadata
    """
    if isinstance(obj, str):
        value = clean_text(obj)
        if value:
            yield path or "$", value
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            yield from flatten_json_strings(item, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for key, value in obj.items():
            child = f"{path}.{key}" if path else str(key)
            yield from flatten_json_strings(value, child)


def extract_json_file(path: Path) -> Iterator[tuple[Optional[int], str]]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    blocks = []
    for key_path, value in flatten_json_strings(obj):
        blocks.append(f"{key_path}\n{value}")
    if blocks:
        yield None, "\n\n".join(blocks)


def extract_source(path: Path) -> Iterator[tuple[Optional[int], str]]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        yield from extract_pdf(path)
    elif ext in {".txt", ".md"}:
        yield from extract_text_file(path)
    elif ext in {".html", ".htm"}:
        yield from extract_html_file(path)
    elif ext == ".json":
        yield from extract_json_file(path)
    else:
        raise ValueError(f"Unsupported source type: {path}")


SCHEMA = """
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS build_meta;
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS sources;

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    version TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL
);

CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    page INTEGER,
    chapter TEXT,
    topic TEXT,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    UNIQUE(source_id, chunk_index)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    chunk_id UNINDEXED,
    source_id UNINDEXED,
    title,
    author,
    category,
    text,
    normalized_text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE build_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX idx_chunks_source ON chunks(source_id);
CREATE INDEX idx_chunks_page ON chunks(page);
"""


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def build(args: argparse.Namespace) -> None:
    manifest_path = Path(args.manifest)
    sources_root = Path(args.sources)
    output_path = Path(args.output)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    chunk_cfg = manifest.get("chunking", {})
    target = int(chunk_cfg.get("target_chars", 1500))
    overlap = int(chunk_cfg.get("overlap_chars", 220))
    min_chars = int(chunk_cfg.get("min_chars", 180))

    enabled_sources = [s for s in manifest.get("sources", []) if s.get("enabled", False)]
    if not enabled_sources:
        raise SystemExit(
            "No enabled sources found in manifest.json. "
            "Add approved sources and set enabled=true."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    con = sqlite3.connect(output_path)
    try:
        con.executescript(SCHEMA)
        total_chunks = 0

        for source in enabled_sources:
            required = {"id", "path", "title"}
            missing = required - set(source)
            if missing:
                raise ValueError(f"Source missing required fields {missing}: {source}")

            src_path = sources_root / source["path"]
            if not src_path.is_file():
                raise FileNotFoundError(
                    f"Manifest source not found: {src_path}"
                )

            sid = str(source["id"])
            title = str(source["title"])
            author = str(source.get("author", ""))
            category = str(source.get("category", "other"))
            version = str(source.get("version", ""))
            notes = str(source.get("notes", ""))
            sha = file_sha256(src_path)

            con.execute(
                """
                INSERT INTO sources
                (id, path, title, author, category, version, notes, sha256)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (sid, source["path"], title, author, category, version, notes, sha),
            )

            chunk_index = 0
            for page, block in extract_source(src_path):
                for piece in paragraph_chunks(block, target, overlap, min_chars):
                    cid = stable_id(sid, str(page or 0), str(chunk_index), piece[:200])
                    normalized = normalize_for_search(piece)
                    chapter = source.get("chapter")
                    topic = source.get("topic")

                    con.execute(
                        """
                        INSERT INTO chunks
                        (id, source_id, chunk_index, page, chapter, topic, text, normalized_text)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            cid, sid, chunk_index, page,
                            chapter, topic, piece, normalized
                        ),
                    )
                    con.execute(
                        """
                        INSERT INTO chunks_fts
                        (chunk_id, source_id, title, author, category, text, normalized_text)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            cid, sid, title, author, category, piece, normalized
                        ),
                    )
                    chunk_index += 1
                    total_chunks += 1

            if chunk_index == 0:
                raise RuntimeError(f"No extractable text found in source: {src_path}")

            print(f"[OK] {title}: {chunk_index} chunks")

        build_meta = {
            "manifest_version": str(manifest.get("version", "unknown")),
            "source_count": str(len(enabled_sources)),
            "chunk_count": str(total_chunks),
            "schema_version": "1",
        }
        con.executemany(
            "INSERT INTO build_meta(key, value) VALUES (?, ?)",
            build_meta.items(),
        )
        con.commit()

        # Compact DB and ensure FTS integrity.
        con.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
        con.commit()
        con.execute("VACUUM")
        con.commit()

    finally:
        con.close()

    print(f"\nBuilt: {output_path}")
    print(f"Sources: {len(enabled_sources)}")
    print(f"Chunks: {total_chunks}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", default="knowledge/manifest.json")
    p.add_argument("--sources", default="knowledge/sources")
    p.add_argument("--output", default="knowledge/output/hawza_knowledge.sqlite")
    return p.parse_args()


if __name__ == "__main__":
    build(parse_args())
