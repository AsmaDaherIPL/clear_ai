# Lessons Learned

> Capture what worked, what didn't, and what to do differently next time.
> Add entries as the build progresses — don't wait until the end.

---

## Format

Each entry follows this structure:

```
### [Date] — Short title
**Context:** What were we doing?
**What happened:** What went wrong/right?
**Lesson:** What do we know now?
**Action:** What changes going forward?
```

---

## Entries

### 2026-04-16 — BUILD.md XML schema was a placeholder, not the real Bayan schema
**Context:** Planning Phase 3.1 (XML template). BUILD.md provided an illustrative `<CustomsDeclaration>` template with simple tag names. We received 5 real baseline XMLs from Naqel.
**What happened:** The real ZATCA/SaudiEDI schema uses a completely different structure — SOAP-style namespaced XML with `decsub:` / `deccm:` / `sau:` / `cm:` prefixes, root `<decsub:saudiEDI>`, and field names like `tariffCode` (not `hsCode`), `goodsDescription` (not `arabicDescription`), `countryOfOrigin` (not `countryOfOrigin`), etc.
**Lesson:** Never take BUILD.md templates literally when real baseline output exists. Always extract schema from ground-truth samples. BUILD.md was clear about this ("This template is a starting point… update to match exactly") but the warning is easy to miss.
**Action:**
- Treat baseline XMLs in `data/Baseline XML output/` as the schema source of truth
- Document extracted schema in INSTRUCTIONS.md (Data Inventory section)
- Hardcoded constants (userid, acctId, broker info, etc.) go into `config.BAYAN_CONSTANTS`, not the template
- Jinja2 template renders only the dynamic per-declaration/per-item fields

---

### 2026-04-16 — Longest-prefix-wins replaces LLM Ranker for most cases
**Context:** BUILD.md Path 3 used a Ranker LLM call when prefix traversal returned 2-15 candidates. Planned threshold `PREFIX_RANKER_MAX_CANDIDATES = 15`.
**What happened:** `HS Code Mapping - Logic.xlsx` shows Naqel's actual algorithm: generate prefix variants (strip last digit repeatedly), match each against master, order by `LEN(ClientHSCode) DESC, LEN(HSCode) ASC`, take first row. **No LLM involved.**
**Lesson:** Naqel's production algorithm is deterministic and cheaper than what BUILD.md proposed. Deterministic beats probabilistic when the rule is clear.
**Action:**
- Replace Ranker LLM path with longest-prefix-wins deterministic logic
- Keep the LLM Reasoner (Path 4) for the truly-unknown-code case (FAISS-based)
- Update hs_resolver.py paths accordingly when we build 2.4c

---

### 2026-04-16 — Sample invoice is 30MB / 50k rows / 3,020 waybills
**Context:** Planning E2E test for Phase 4.2.
**What happened:** `client_commercial_invoices_sample2.xlsx` is much larger than expected (30MB, 50k rows). Column layout matches BUILD.md spec exactly.
**Lesson:** Test infrastructure needs to handle large inputs. Streaming xlsx read (openpyxl read_only mode) is essential — loading the whole thing into memory will crash.
**Action:**
- `invoice_parser.py` must use `openpyxl.load_workbook(readonly=True)` + `iter_rows(values_only=True)`
- Do NOT use `pandas.read_excel` for the main parser path — it loads everything in memory
- For Phase 4.2 test: use a 100-row subset first, then scale up
