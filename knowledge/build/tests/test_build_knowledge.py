import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "build_knowledge.py"


class BuildKnowledgeTests(unittest.TestCase):
    def test_builds_searchable_database_from_reviewed_chunk(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            processed = root / "processed"
            processed.mkdir()
            (root / "manifest.json").write_text(json.dumps({"version": "1.0.0", "sources": []}), encoding="utf-8")
            (processed / "aqidah.json").write_text(
                json.dumps([{
                    "id": "aqidah-001",
                    "book_id": "example-book",
                    "book_title": "كتاب مثال",
                    "category": "aqidah",
                    "chapter": "التوحيد",
                    "page": 31,
                    "text": "نص تجريبي حول التوحيد.",
                }]),
                encoding="utf-8",
            )
            output = root / "hawza_knowledge.sqlite"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(root / "manifest.json"), "--processed-dir", str(processed), "--output", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            with sqlite3.connect(output) as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM source_chunks").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT id FROM source_chunks_fts WHERE source_chunks_fts MATCH 'التوحيد'").fetchone()[0], "aqidah-001")

    def test_rejects_duplicate_source_identifiers(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            processed = root / "processed"
            processed.mkdir()
            (root / "manifest.json").write_text(json.dumps({"version": "1.0.0", "sources": []}), encoding="utf-8")
            chunk = {"id": "same-id", "book_id": "book", "book_title": "Book", "category": "test", "text": "Text"}
            (processed / "duplicates.json").write_text(json.dumps([chunk, chunk]), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(root / "manifest.json"), "--processed-dir", str(processed), "--output", str(root / "output.sqlite")],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Duplicate chunk id", result.stderr)
