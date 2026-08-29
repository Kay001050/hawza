# Smoke-test the pipeline before adding real sources

The production `knowledge/manifest.json` intentionally has no enabled example source.

To verify that the code works using the technical sample:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r knowledge/build/requirements.txt

python knowledge/build/build_knowledge.py \
  --manifest knowledge/manifest.sample-test.json \
  --output knowledge/output/hawza_knowledge.sqlite

python knowledge/build/validate_knowledge.py \
  --query "التوحيد"
```

After the smoke test, edit `knowledge/manifest.json`, add your real approved source files, and run the normal build:

```bash
python knowledge/build/build_knowledge.py
python knowledge/build/validate_knowledge.py --query "الإمامة"
```
