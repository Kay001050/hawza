#!/usr/bin/env python3
"""Validate reviewed Hawza chunks and build an iOS-ready SQLite FTS database."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


REQUIRED_FIELDS = ("id", "book_id", "book_title", "category", "text")
OPTIONAL_FIELDS = ("author", "volume", "chapter", "page", "topic", "source_version")


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read manifest {path}: {error}") from error

    if not isinstance(manifest, dict) or not isinstance(manifest.get("version"), str):
        raise ValueError("manifest.json must be an object with a string version")
    if not isinstance(manifest.get("sources"), list):
        raise ValueError("manifest.json must contain a sources array")
    return manifest


def load_chunks(processed_dir: Path, default_version: str) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for path in sorted(processed_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Cannot read processed source {path}: {error}") from error

        entries = data.get("chunks") if isinstance(data, dict) else data
        if not isinstance(entries, list):
            raise ValueError(f"{path} must be an array or contain a chunks array")

        for index, chunk in enumerate(entries, start=1):
            if not isinstance(chunk, dict):
                raise ValueError(f"{path}:{index} must be an object")
            missing = [field for field in REQUIRED_FIELDS if not isinstance(chunk.get(field), str) or not chunk[field].strip()]
            if missing:
                raise ValueError(f"{path}:{index} is missing required text fields: {', '.join(missing)}")
            chunk_id = chunk["id"].strip()
            if chunk_id in seen_ids:
                raise ValueError(f"Duplicate chunk id: {chunk_id}")
            if "page" in chunk and chunk["page"] is not None and (not isinstance(chunk["page"], int) or chunk["page"] < 1):
                raise ValueError(f"{path}:{index} page must be a positive integer when supplied")

            seen_ids.add(chunk_id)
            normalized = {field: chunk.get(field) for field in REQUIRED_FIELDS + OPTIONAL_FIELDS}
            normalized["id"] = chunk_id
            normalized["source_version"] = normalized["source_version"] or default_version
            chunks.append(normalized)
    return chunks


def build_database(output_path: Path, chunks: list[dict[str, Any]], source_version: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    connection = sqlite3.connect(output_path)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode = DELETE;
            CREATE TABLE source_chunks (
                id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL,
                book_title TEXT NOT NULL,
                author TEXT,
                category TEXT NOT NULL,
                volume TEXT,
                chapter TEXT,
                page INTEGER,
                topic TEXT,
                text TEXT NOT NULL,
                source_version TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
                id UNINDEXED,
                book_title,
                chapter,
                topic,
                text,
                tokenize = 'unicode61'
            );
            CREATE TABLE knowledge_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        for chunk in chunks:
            values = tuple(chunk[field] for field in ("id", "book_id", "book_title", "author", "category", "volume", "chapter", "page", "topic", "text", "source_version"))
            connection.execute("INSERT INTO source_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values)
            connection.execute(
                "INSERT INTO source_chunks_fts VALUES (?, ?, ?, ?, ?)",
                (chunk["id"], chunk["book_title"], chunk["chapter"], chunk["topic"], chunk["text"]),
            )
        connection.executemany(
            "INSERT INTO knowledge_metadata VALUES (?, ?)",
            (("schema_version", "1"), ("source_version", source_version), ("chunk_count", str(len(chunks)))),
        )
        connection.commit()
    finally:
        connection.close()


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=root / "manifest.json")
    parser.add_argument("--processed-dir", type=Path, default=root / "processed")
    parser.add_argument("--output", type=Path, default=root / "output" / "hawza_knowledge.sqlite")
    arguments = parser.parse_args()

    try:
        manifest = load_manifest(arguments.manifest)
        chunks = load_chunks(arguments.processed_dir, manifest["version"])
        build_database(arguments.output, chunks, manifest["version"])
    except ValueError as error:
        print(f"Knowledge build failed: {error}", file=sys.stderr)
        return 1

    print(f"Built {arguments.output} with {len(chunks)} reviewed chunk(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
