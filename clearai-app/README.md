# ClearAI

Local Python CLI that resolves merchant invoice line items to ZATCA-compliant
Saudi HS codes and emits Bayan XML customs declarations.

## Quick start

```bash
# 1. Install
pip install -e ".[dev]"

# 2. Configure
cp .env.example .env
# edit .env — set LLM_BACKEND and ANTHROPIC_API_KEY

# 3. Place data files (see data/README.md)

# 4. Build database + FAISS index (one-time setup)
python db/setup.py

# 5. Run
python run.py --input data/client_commercial_invoices_sample2.xlsx --output ./output/
```

## Project docs

- `tracker/INSTRUCTIONS.md` — build rules, conventions, data inventory
- `tracker/PROGRESS.md` — phase-by-phase task tracker with verify commands
- `tracker/LESSONS.md` — lessons learned log
- `tracker/ARCHITECTURE.md` — ADRs for key design decisions
- `tracker/DATA_AUDIT.md` — source data coverage analysis

## Structure

```
clearai-app/
├── config.py                 # settings, env vars, Bayan constants
├── invoice_parser.py         # xlsx/csv streaming reader
├── hs_resolver.py            # 4-path resolution logic
├── lookup_engine.py          # SQLite joins for currency/city/source/origin
├── arabic_translation_engine.py  # Arabic description resolution
├── xml_builder.py            # Jinja2 → ZATCA XML
├── comparator.py             # diff vs baseline XMLs
├── run.py                    # CLI entry point
├── llm/                      # HSReasoner implementations
├── db/                       # setup + write-back scripts
├── templates/                # Jinja2 XML template
├── data/                     # source xlsx + baseline XMLs (not committed)
├── output/                   # generated XML, review.csv, audit.log
├── tests/                    # pytest suite
└── tracker/                  # project docs (progress, lessons, ADRs)
```
