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
            sources = root / "sources"
            sources.mkdir()
            (root / "manifest.json").write_text(json.dumps({"version": "1.0.0", "chunking": {"target_chars": 50, "overlap_chars": 0, "min_chars": 10}, "sources": [{"id": "aqidah-001", "path": "aqidah.txt", "title": "كتاب مثال", "category": "aqidah", "enabled": True}]}), encoding="utf-8")
            (sources / "aqidah.txt").write_text("نص تجريبي حول التوحيد يشتمل على معلومات تقنية لا تمثل مصدرا دينيا.", encoding="utf-8")
            output = root / "hawza_knowledge.sqlite"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(root / "manifest.json"), "--sources", str(sources), "--output", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            with sqlite3.connect(output) as connection:
                self.assertGreaterEqual(connection.execute("SELECT count(*) FROM chunks").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT source_id FROM chunks_fts WHERE chunks_fts MATCH 'التوحيد'").fetchone()[0], "aqidah-001")

    def test_rejects_manifest_source_that_is_missing_from_disk(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            sources = root / "sources"
            sources.mkdir()
            (root / "manifest.json").write_text(json.dumps({"version": "1.0.0", "sources": [{"id": "missing", "path": "missing.txt", "title": "Missing", "enabled": True}]}), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(root / "manifest.json"), "--sources", str(sources), "--output", str(root / "output.sqlite")],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Manifest source not found", result.stderr)
