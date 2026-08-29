# Hawza → Native Apple Foundation Models
## Complete zero-OpenAI-API implementation package

This package is intended to be copied into the `foundation-models` branch of your fork of:

`iAlMosawi/hawza`

The original repository currently contains the Hawza website, `book/`, `data/`, and Netlify functions. The repository README describes Noor Al-Hawza's methodology and approved source families, but creating a Git branch by itself does not make Apple Foundation Models read that content.

This package creates the missing bridge:

```text
Approved Hawza documents
        ↓
knowledge/build/build_knowledge.py
        ↓
hawza_knowledge.sqlite
        ↓
Native iOS local search
        ↓
Relevant source passages
        ↓
Apple Foundation Models
        ↓
Grounded Noor Al-Hawza answer
```

The strict local path requires **no OpenAI API key** and makes **no OpenAI API calls**.

---

# A. Repository layout after installation

Copy the folders/files from this package into the root of your `hawza` repository.

```text
hawza/
├── .github/
│   └── workflows/
│       └── build-hawza-knowledge.yml
│
├── knowledge/
│   ├── README.md
│   ├── manifest.json
│   ├── noor-instructions.md
│   ├── sources/
│   │   └── .gitkeep
│   ├── processed/
│   │   └── .gitkeep
│   ├── output/
│   │   └── .gitkeep
│   └── build/
│       ├── build_knowledge.py
│       ├── validate_knowledge.py
│       └── requirements.txt
│
└── ios/
    └── AI/
        ├── README_XCODE.md
        ├── ChatMessage.swift
        ├── HawzaSourceChunk.swift
        ├── HawzaDatabase.swift
        ├── HawzaRetrievalService.swift
        ├── NoorInstructions.swift
        ├── NoorModelService.swift
        ├── NoorAlHawzaService.swift
        ├── HawzaChatViewModel.swift
        └── HawzaChatView.swift
```

---

# B. First-time setup

## 1. Work on the correct branch

```bash
git checkout foundation-models
```

If it does not exist yet:

```bash
git checkout -b foundation-models
```

Keep `main` available for synchronization with the original upstream repository.

---

## 2. Put approved source files into `knowledge/sources/`

Supported by the included builder:

- `.pdf`
- `.txt`
- `.md`
- `.html` / `.htm`
- `.json`

Example:

```text
knowledge/sources/
├── aqida/
│   ├── fi_rihab_al_aqida.pdf
│   └── dirasat_ilahiyyat.pdf
├── sirah/
│   └── sirah.pdf
└── fiqh/
    └── approved_fiqh_source.pdf
```

**Important:** only put sources you have the right to redistribute/bundle in the iOS app. If a PDF cannot legally be bundled, do not commit it to a public GitHub repository. Use a private build process or obtain permission.

The current public Hawza repository does **not** appear to contain the full set of PDFs named in the README, so you must supply the approved source documents that should actually be searchable.

---

## 3. Edit `knowledge/manifest.json`

Every approved source should have a manifest entry.

Example:

```json
{
  "id": "fi-rihab-al-aqida",
  "path": "aqida/fi_rihab_al_aqida.pdf",
  "title": "في رحاب العقيدة",
  "author": "",
  "category": "aqidah",
  "enabled": true
}
```

`path` is relative to `knowledge/sources/`.

Only `enabled: true` sources are indexed.

---

## 4. Install Python dependencies

From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r knowledge/build/requirements.txt
```

---

## 5. Build the database

```bash
python knowledge/build/build_knowledge.py
```

Output:

```text
knowledge/output/hawza_knowledge.sqlite
```

The builder:

- reads `manifest.json`;
- extracts text from supported files;
- preserves PDF page numbers where available;
- normalizes Arabic text for search;
- chunks long source text;
- writes metadata;
- creates SQLite FTS5 full-text search;
- writes build statistics.

---

## 6. Validate it

```bash
python knowledge/build/validate_knowledge.py
```

Optional search test:

```bash
python knowledge/build/validate_knowledge.py --query "التوحيد"
```

You should see matching source passages.

---

# C. Xcode integration

The Swift files in `ios/AI/` are starter implementation files to add to your actual iOS app target.

## Required deployment environment

Apple's Foundation Models framework is available on supported Apple Intelligence devices/OS versions. The included code is guarded with availability checks.

You must compile using an Xcode/SDK version that contains `FoundationModels`.

## 1. Add these Swift files to your app target

From:

```text
ios/AI/
```

Add:

```text
ChatMessage.swift
HawzaSourceChunk.swift
HawzaDatabase.swift
HawzaRetrievalService.swift
NoorInstructions.swift
NoorModelService.swift
NoorAlHawzaService.swift
HawzaChatViewModel.swift
HawzaChatView.swift
```

Ensure your app target is checked in **Target Membership**.

## 2. Add SQLite library

The files use Apple's system `SQLite3`.

In Xcode:

```text
Target
→ Build Phases
→ Link Binary With Libraries
→ libsqlite3.tbd
```

## 3. Bundle the knowledge database

Add:

```text
knowledge/output/hawza_knowledge.sqlite
```

to the Xcode project and ensure:

```text
Target Membership → your iOS app
```

is enabled.

Then verify:

```text
Target
→ Build Phases
→ Copy Bundle Resources
```

contains:

```text
hawza_knowledge.sqlite
```

## 4. Replace your WebView destination

Remove/stop using the AI screen that loads:

```text
chatgpt.com/g/...
```

or `WKWebView`.

Use:

```swift
NavigationLink {
    HawzaChatView()
} label: {
    Text("نور الحوزة")
}
```

---

# D. Runtime flow

The included implementation follows this path:

```text
User question
    ↓
HawzaChatViewModel
    ↓
NoorAlHawzaService
    ↓
HawzaRetrievalService
    ↓
HawzaDatabase / SQLite FTS5
    ↓
Top relevant approved passages
    ↓
NoorModelService
    ↓
Apple Foundation Models
    ↓
Answer
    ↓
Native source cards
```

The model is not asked to invent bibliographic metadata. Source cards come from SQLite metadata.

---

# E. Unsupported-device fallback

Strict zero-API-cost mode intentionally does **not** fall back to OpenAI.

If Apple Foundation Models are unavailable:

```text
AI generation unavailable
        ↓
Local Hawza source search remains available
```

You can later build a `HawzaSearchView` if desired, but do not silently send user questions to a paid API if your requirement is zero API cost.

---

# F. Updating knowledge when upstream changes

Your existing upstream fork sync can remain:

```text
Kay001050/hawza
    ↓
iAlMosawi/hawza:main
```

When relevant content changes:

```bash
git checkout foundation-models
git fetch origin
git merge origin/main
```

Resolve any conflicts.

Then rebuild:

```bash
python knowledge/build/build_knowledge.py
python knowledge/build/validate_knowledge.py
```

Commit the updated database only if that fits your repository size/licensing policy.

A GitHub Action in this package can validate/build when `knowledge/**` changes.

---

# G. Important source-integrity rules

1. Do not treat the model's memory as a religious citation source.
2. Retrieve local approved evidence before source-dependent religious answers.
3. Never let the model invent page numbers.
4. Display source title/page from SQLite metadata.
5. If retrieval finds insufficient evidence, say so.
6. For fiqh that depends on taqlid, ask/track the user's marja and retrieve the corresponding approved material.
7. For current fatwas, local bundled material can become stale. Include source version/date metadata and update it deliberately.
8. Review all religious-source additions before production release.

---

# H. Cost

For the strict on-device design in this package:

```text
OpenAI API calls:          0
OpenAI token cost:         $0
OpenAI API key required:   No
ChatGPT WebView required:  No
```

Other costs such as Apple Developer Program membership, hosting, analytics, or distribution are separate.

---

# I. What this package does NOT do automatically

It does not magically import the full Custom GPT knowledge from ChatGPT.

You must place approved source documents in `knowledge/sources/` and list them in `manifest.json`.

It also does not guarantee identical quality to the current Custom GPT. The Apple on-device model has a different capability profile and context window, so retrieval quality and prompts must be tested on real supported devices.

---

# J. End-to-end completion checklist

- [ ] `foundation-models` branch exists.
- [ ] Package files copied to repo.
- [ ] Approved source documents added.
- [ ] `knowledge/manifest.json` completed.
- [ ] `pip install -r knowledge/build/requirements.txt`.
- [ ] `build_knowledge.py` runs without errors.
- [ ] `hawza_knowledge.sqlite` generated.
- [ ] `validate_knowledge.py` passes.
- [ ] Arabic search returns useful results.
- [ ] Swift AI files added to Xcode target.
- [ ] `libsqlite3.tbd` linked.
- [ ] `hawza_knowledge.sqlite` added to Copy Bundle Resources.
- [ ] App compiles with `FoundationModels`.
- [ ] `HawzaChatView()` replaces the old WebView AI destination.
- [ ] Model availability fallback tested.
- [ ] Answers show database-derived source cards.
- [ ] Missing-evidence behavior tested.
- [ ] Fiqh/marja flow tested.
- [ ] No OpenAI API key remains necessary for this path.
- [ ] Test on a real supported iPhone before release.
