# Hawza Knowledge Pipeline

This folder converts approved Hawza source documents into a local SQLite FTS5 database for the native iOS assistant.

## Build

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r knowledge/build/requirements.txt
python knowledge/build/build_knowledge.py
python knowledge/build/validate_knowledge.py --query "التوحيد"
```

Output:

```text
knowledge/output/hawza_knowledge.sqlite
```

## Supported source formats

- PDF (via PyMuPDF)
- TXT
- Markdown
- HTML
- JSON

Only files listed in `manifest.json` with `"enabled": true` are indexed.

## Licensing

Do not commit copyrighted books to a public repository unless you have permission to redistribute them. The database contains extracted source text, so the same licensing concern applies to the generated database.
