cat > "/Users/asma/Desktop/Customs AI/clear_ai/.claude/CLAUDE.md" << 'ENDOFFILE'
# Clear AI — Project Intelligence

## What We're Building
AI-powered Saudi customs clearance platform. Automates HS code classification
and ZATCA-compliant declaration generation at scale — eliminating the manual,
error-prone workflows that stall Saudi border clearance today.

The core problem: importers rarely provide complete product descriptions, forcing
clearance agents to manually research HS codes per item. At volume, this is
unsustainable. Clear AI classifies goods intelligently, flags low-confidence
results for human review only when needed, and generates ZATCA-ready declarations
in Arabic and English automatically.

---

## Domain Context — Know This Before Touching Anything

**ZATCA** — Saudi Customs Authority. All declarations submit via ZATCA's H2H API
as XML. Rejection means re-submission delay. Acceptance rate is a primary KPI.

**HS Code** — 12-digit Harmonized System tariff code. Every import line item needs
one. We classify these via AI. Invalid or wrong codes = compliance risk.

**Bayan** — ZATCA's customs clearance reference number. Issued after successful
declaration submission. The end goal of every shipment.

**HV / LV Split** — Shipments >= 1,000 SAR are High Value (full HS code + invoice
item section in declaration). Below that is Low Value (lighter processing). Every
feature decision must account for this split.

**Naqel** — Saudi logistics provider. Primary integration partner and source of
the 353,623-line training dataset. Their gateway team currently handles manual
HS code resolution for ~1-2% of HV shipments — our primary automation target.

**PDPL** — Saudi Personal Data Protection Law. All data must stay KSA-resident.
Azure region selection must comply. Multi-tenant isolation is non-negotiable.

---

## User Personas

**Carrier Integration Engineer** — IT/Dev at logistics company. API-only.
Never touches UI. Cares about: latency <1s per item, uptime, schema stability.

**Carrier Ops Manager** — Operations lead at carrier. Web UI. Manages review
queue, downloads declaration batches, tracks accuracy trends.

**Independent Clearance Agent** — Licensed customs broker serving multiple
clients. Web UI. No technical setup. Needs carrier-agnostic tooling.

**Importer/Shipper** — Business owner or procurement team. Simplified web UI.
Wants HS code + duty estimate before committing to shipment.

---

## Current Roadmap Status

**V1 MVP — Ship Now (P0):**
- HS Code Classification (text input, minimal data)
- Classify Boost (AI enrichment for sparse product descriptions)
- ZATCA Declaration Generator (Arabic + English output)
- Confidence Scoring + Human Review Queue (threshold-based routing)
- Bulk CSV/Excel Processing (async jobs, webhook on completion)
- REST API + Webhooks
- Agent Web UI (submit, review, manage queue, download, history)
- Multi-tenant auth

**V2 — Post-Launch (P1):**
- Direct ZATCA Submission (with credentials, returns Bayan reference)
- ZATCA Status Tracking + Webhooks
- Image-Based Classification (photo to HS code, no text needed)
- Invoice/Packing List OCR
- Ops Dashboard (throughput, confidence distribution, queue backlog)
- Per-tenant confidence thresholds

**Later — Architecture Support Only (P2, Not Commitments):**
- Duty & Tax Estimation Engine
- Predictive Risk Scoring
- Mobile Agent App
- GCC Cross-Border Expansion
- Customs Broker Marketplace

**V1 Non-Goals:** Duty payment processing, broker credentialing, export
declarations, GCC expansion.

---

## Tech Stack

- **Frontend:** React + TypeScript + Tailwind CSS
- **Backend:** Node.js (REST API layer connecting to Azure services)
- **Cloud:** Azure (KSA region for data residency)
- **Database:** Supabase (PostgreSQL)
- **Infrastructure:** Cloudflare (edge, DNS, security)
- **Language:** TypeScript everywhere — no plain JS

**Architectural Principles (Non-Negotiable):**
- API-first always. Web UI is a client of the same REST API. No UI-only features.
- Every capability accessible programmatically.
- Async bulk jobs with webhook delivery — never block the caller.
- Multi-tenant data isolation on every query. Never leak cross-tenant data.
- KSA data residency — no data leaves Saudi Azure region.
- Arabic language support is a first-class requirement, not an afterthought.

---

## HS Code Resolution Pipeline (Understand Before Modifying)

Current 5-step algorithm:
1. **Clean** — Remove dots, spaces, non-numeric characters
2. **Search keys** — Strip digits from right repeatedly down to 4 digits
3. **Lookup** — Search HSCodeMaster for each candidate
4. **Pick best** — Prefer longest matching key; tie-break: shorter ZATCA code
5. **Use top result** — Winning code = tariff code; Arabic name = goods description

**Known data quality issues:**
- 83.9% of items arrive with complete 12-digit codes (no resolution needed)
- 13.6% are short codes (6-11 digits) — auto-completed via algorithm
- ~1.8% HV shipments arrive with no code — currently manual gateway workaround
- Unknown rate of wrong-but-valid-format codes — highest-value AI opportunity,
  hardest to measure without labelled ground truth

---

## ZATCA XML Structure (7 Sections)

When working on declaration generation, always respect this structure:
1. Reference (docRefNo, broker credentials, port code)
2. Declaration Header (type=2 Import, finalCountry=SA)
3. Invoice (AWB number, declared value, currency, weight, source company)
4. Invoice Item — HV only (HS code, Arabic description, origin, cost, weight)
5. Air Waybill (AWB number, carrier prefix, shipment date)
6. Express Mail Info (consignee ID, name, city, address — Arabic city name)
7. Declaration Documents (commercial invoice reference)

**Known fragilities:**
- ZIP code and PO Box are hardcoded placeholders (1111 / 11) — ZATCA does not
  validate today but this is latent risk if they tighten validation
- ZATCA rejects exact string matches to official tariff text — extra words must
  be appended to Arabic description (convention, not code — fragile)
- Currency mapping: ~97.5% SAR, 1.4% USD, 0.9% AED — ISO to ZATCA numeric ID

---

## Success Metrics — Always Keep These in Mind

- HS Code Accuracy Rate: >= 92% on held-out dataset (pre-launch validation)
- Time to Classification: < 1s per item (p95), < 10min per 500-item batch
- Human Review Rate: < 15% of items flagged
- API Integration Rate: >= 1 live carrier within 60 days of launch
- Declaration Acceptance Rate: >= 95% accepted by ZATCA without re-submission
- Agent Weekly Active Use: >= 60% of registered agents active in week 4

---

## Agent Routing for This Project

- API design, endpoint contracts, webhook specs → api-designer
- Node.js backend, ZATCA XML generation, HS resolution logic → backend-developer
- React UI, review queue, bulk upload interface → react-specialist
- TypeScript types, interfaces, strict typing → typescript-pro
- Next.js routing, SSR decisions, page structure → nextjs-developer
- End-to-end feature work crossing API + UI → fullstack-developer
- Azure services, infra decisions, KSA data residency → azure-infra-engineer (global)
- AI classification design, confidence scoring → ai-engineer (global)
- LLM architecture for Classify Boost, HS enrichment → llm-architect (global)
- Customs data pipelines, shipment datasets → data-engineer (global)
- Security, multi-tenant isolation, PDPL compliance → security-auditor (global)
- ZATCA compliance, regulatory rules → compliance-auditor (global)
- PRD, feature specs, roadmap decisions → product-manager (global)
- Sprint planning, backlog → scrum-master (global)
- Complex multi-step tasks → workflow-orchestrator first (global)

---

## Critical Risks — Never Ignore These

1. **Wrong-but-valid HS codes** — Client submits syntactically correct but wrong
   code (e.g., phone code for clothing). Current system does not detect this.
   Highest-value AI opportunity but needs labelled ground truth to baseline.

2. **ZATCA exact-match rejection** — Arabic description cannot be exact copy of
   official tariff text. Always append additional descriptive words.

3. **Missing HS code bypass gap** — ~1-2% HV shipments entered manually in ZATCA
   portal; correction never written back upstream. Hardest training cases missing.

4. **Multi-tenant data leakage** — Every DB query must be tenant-scoped.
   Security review on any query touching shipment or declaration data.

5. **KSA data residency** — Any new Azure service must be confirmed available in
   KSA region and PDPL-compliant before use.

---

## Code Standards

- TypeScript strict mode — no `any` without explicit justification
- All API endpoints must have schema validation (input + output)
- Arabic text is first-class — test all text processing with Arabic inputs
- Every async operation must have a webhook/callback path — no polling APIs
- ADR required for any architectural decision (Azure service choice, schema
  design, auth approach, third-party integration)
- Accessibility check on every UI component before merge
- Security review on any auth or data isolation change before merge
ENDOFFILE