#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata

ARABIC_DIACRITICS = re.compile(
    r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]"
)
WORD = re.compile(r"[\w\u0600-\u06FF]+", re.UNICODE)

def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = ARABIC_DIACRITICS.sub("", value).replace("ـ", "")
    value = value.translate(str.maketrans({
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
        "ى": "ي", "ؤ": "و", "ئ": "ي",
    }))
    return " ".join(value.lower().split())

def fts_query(value: str) -> str:
    tokens = [t for t in WORD.findall(normalize(value)) if len(t) > 1][:12]
    if not tokens:
        return '""'
    # OR improves recall for Arabic morphology in a simple FTS setup.
    return " OR ".join(f'"{t.replace(chr(34), "")}"' for t in tokens)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="knowledge/output/hawza_knowledge.sqlite")
    p.add_argument("--query")
    p.add_argument("--limit", type=int, default=5)
    args = p.parse_args()

    path = Path(args.db)
    if not path.is_file():
        raise SystemExit(f"Database not found: {path}")

    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    try:
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SystemExit(f"SQLite integrity check failed: {integrity}")

        source_count = con.execute("SELECT count(*) FROM sources").fetchone()[0]
        chunk_count = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
        fts_count = con.execute("SELECT count(*) FROM chunks_fts").fetchone()[0]

        if source_count < 1 or chunk_count < 1 or fts_count != chunk_count:
            raise SystemExit(
                f"Invalid counts: sources={source_count}, chunks={chunk_count}, fts={fts_count}"
            )

        print(f"[OK] integrity: {integrity}")
        print(f"[OK] sources: {source_count}")
        print(f"[OK] chunks: {chunk_count}")

        if args.query:
            q = fts_query(args.query)
            rows = con.execute(
                """
                SELECT
                    c.id, s.title, s.author, c.page, c.text,
                    bm25(chunks_fts) AS rank
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.chunk_id
                JOIN sources s ON s.id = c.source_id
                WHERE chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (q, args.limit),
            ).fetchall()

            print(f"\nQuery: {args.query}")
            print(f"FTS:   {q}")
            for i, r in enumerate(rows, 1):
                snippet = " ".join(r["text"].split())[:320]
                print(
                    f"\n{i}. {r['title']} | page={r['page']} | id={r['id']}\n"
                    f"   {snippet}"
                )

            if not rows:
                print("No results.")
    finally:
        con.close()

if __name__ == "__main__":
    main()
