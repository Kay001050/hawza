# Noor Local Knowledge

This directory contains the reviewed source material that grounds the native iOS Noor Al-Hawza assistant. It is intentionally empty until approved, rights-cleared material is provided.

## Layout

- `sources/`: original approved material, retained for provenance and review.
- `processed/`: reviewed JSON chunks passed to the database builder.
- `metadata/`: optional structured book-level metadata.
- `build/`: reproducible validation and SQLite build tools.
- `output/`: generated iOS database. SQLite files are not committed to Git.

## Processed chunk format

Each JSON file contains either an array of chunks or an object with a `chunks` array. Every chunk requires:

```json
{
  "id": "unique-source-id",
  "book_id": "stable-book-id",
  "book_title": "عنوان الكتاب",
  "category": "aqidah",
  "text": "النص المعتمد"
}
```

Optional verified fields are `author`, `volume`, `chapter`, `page`, `topic`, and `source_version`. `page` must be a positive integer when present. Never add metadata that cannot be verified from the approved original material.

## Build and validate

```bash
python3 knowledge/build/build_knowledge.py
python3 -m unittest discover -s knowledge/build/tests
```

The builder writes `knowledge/output/hawza_knowledge.sqlite` with a `source_chunks` table and an FTS5 index named `source_chunks_fts`. The iOS application must display citations from `source_chunks` metadata, not model-generated bibliography.
