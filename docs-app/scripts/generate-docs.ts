/**
 * generate-docs.ts
 * ────────────────
 * Reads the content modules in src/content/ and generates markdown files
 * in the ../docs/ folder.  Both the docs-app and the markdown docs are
 * derived from the SAME content — edit src/content/*.ts, then run:
 *
 *   npm run generate-docs
 *
 * Requires: tsx (npm i -D tsx)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Import content modules ──
import * as pd from '../src/content/product-definition';
import * as proc from '../src/content/process';
import * as arch from '../src/content/architecture';
import * as ref from '../src/content/reference';

// ── Helpers ──
/** Strip simple markdown bold/italic for plain text, keep backticks */
function mdToPlain(text: string): string {
  return text;  // We keep markdown as-is since the output IS markdown
}

function hr() { return '\n---\n'; }

function table(headers: string[], rows: string[][]) {
  const hLine = '| ' + headers.join(' | ') + ' |';
  const sep   = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body  = rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
  return hLine + '\n' + sep + '\n' + body;
}

// ── Generators ──

function generateProductDefinition(): string {
  const lines: string[] = [];
  const { PAGE: P, PROBLEM, SOLUTION, TARGET_CUSTOMER, FEATURES_SECTION, FEATURES,
          METRICS_SECTION, METRICS, ROADMAP, OPEN_QUESTIONS } = pd;

  lines.push(`# ${P.chapter}`);
  lines.push(`## ${P.pageTitle}\n`);
  lines.push(P.hero.lede);
  lines.push(hr());

  // Problem
  lines.push(`## ${PROBLEM.num}. ${PROBLEM.label}\n`);
  lines.push(`### ${PROBLEM.title}\n`);
  lines.push(PROBLEM.desc + '\n');
  for (const issue of PROBLEM.issues) {
    lines.push(`**${issue.label}: ${issue.title}**`);
    lines.push(issue.body + '\n');
  }
  lines.push(hr());

  // Solution
  lines.push(`## ${SOLUTION.num}. ${SOLUTION.label}\n`);
  lines.push(`### ${SOLUTION.title}\n`);
  lines.push(SOLUTION.desc + '\n');
  lines.push(`### Three Product Modes\n`);
  lines.push(SOLUTION.modesIntro + '\n');
  for (const mode of SOLUTION.modes) {
    lines.push(`#### ${mode.num}: ${mode.name}\n`);
    lines.push(`**${mode.role}**\n`);
    lines.push('**When to use:**\n');
    for (const item of mode.whenToUse) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push(hr());

  // Target Customer
  lines.push(`## ${TARGET_CUSTOMER.num}. ${TARGET_CUSTOMER.label}\n`);
  lines.push(`### ${TARGET_CUSTOMER.title}\n`);
  lines.push(TARGET_CUSTOMER.desc + '\n');
  for (const seg of TARGET_CUSTOMER.segments) {
    lines.push(`#### ${seg.num}: ${seg.name}\n`);
    lines.push(seg.role + '\n');
    for (const sub of seg.subsections) {
      lines.push(`**${sub.label}:**\n`);
      for (const item of sub.items) lines.push(`- ${item}`);
      lines.push('');
    }
  }
  lines.push(`> **Note:** ${TARGET_CUSTOMER.note}\n`);
  lines.push(hr());

  // Features
  lines.push(`## ${FEATURES_SECTION.num}. ${FEATURES_SECTION.label}\n`);
  lines.push(`### ${FEATURES_SECTION.title}\n`);
  lines.push(FEATURES_SECTION.desc + '\n');
  const grouped = new Map<string, typeof FEATURES>();
  for (const f of FEATURES) {
    if (!grouped.has(f.modeLabel)) grouped.set(f.modeLabel, []);
    grouped.get(f.modeLabel)!.push(f);
  }
  for (const [mode, feats] of grouped) {
    lines.push(`#### ${mode}\n`);
    for (const f of feats) {
      lines.push(`- **${f.feature}:** ${f.description}`);
    }
    lines.push('');
  }
  lines.push(hr());

  // Metrics
  lines.push(`## ${METRICS_SECTION.num}. ${METRICS_SECTION.label}\n`);
  lines.push(`### ${METRICS_SECTION.title}\n`);
  lines.push(METRICS_SECTION.desc + '\n');
  for (const [group, metrics] of Object.entries(METRICS)) {
    lines.push(`#### ${group.charAt(0).toUpperCase() + group.slice(1)}\n`);
    for (const m of metrics) {
      lines.push(`- **${m.title}** (${m.category}): ${m.target}. ${m.note}`);
    }
    lines.push('');
  }
  lines.push(hr());

  // Roadmap & Open Questions
  lines.push(`## ${ROADMAP.num}. ${ROADMAP.label}\n`);
  lines.push(`### ${ROADMAP.title}\n`);
  lines.push(`*${ROADMAP.placeholder}*\n`);
  lines.push(hr());
  lines.push(`## ${OPEN_QUESTIONS.num}. ${OPEN_QUESTIONS.label}\n`);
  lines.push(`### ${OPEN_QUESTIONS.title}\n`);
  lines.push(`*${OPEN_QUESTIONS.placeholder}*`);

  return lines.join('\n');
}

function generateProcess(): string {
  const lines: string[] = [];

  lines.push(`# ${proc.PAGE.chapter}`);
  lines.push(`## ${proc.PAGE.pageTitle}\n`);
  lines.push(proc.PAGE.hero.lede);
  lines.push(hr());

  // Big Picture
  lines.push(`## ${proc.BIG_PICTURE.num}. ${proc.BIG_PICTURE.label}\n`);
  lines.push(`### ${proc.BIG_PICTURE.title}\n`);
  lines.push(proc.BIG_PICTURE.desc + '\n');
  lines.push(hr());

  // HV/LV
  lines.push(`## ${proc.HVLV.num}. ${proc.HVLV.label}\n`);
  lines.push(`### ${proc.HVLV.title}\n`);
  lines.push(proc.HVLV.desc + '\n');
  lines.push('**Applies to both HV & LV:**\n');
  for (const s of proc.HVLV.shared) lines.push(`- ${s}`);
  lines.push(`\n*${proc.HVLV.sharedNote}*\n`);

  lines.push(`#### High Value (${proc.HVLV.hv.threshold})\n`);
  for (const r of proc.HVLV.hv.rules) lines.push(`- ${r.icon} ${r.text}`);
  lines.push('');

  lines.push(`#### Low Value (${proc.HVLV.lv.threshold})\n`);
  for (const r of proc.HVLV.lv.rules) lines.push(`- ${r.icon} ${r.text}`);
  lines.push(hr());

  // Data Intake
  lines.push(`## ${proc.DATA_INTAKE.num}. ${proc.DATA_INTAKE.label}\n`);
  lines.push(`### ${proc.DATA_INTAKE.title}\n`);
  lines.push(proc.DATA_INTAKE.desc + '\n');
  for (const ch of proc.DATA_INTAKE.channels) {
    lines.push(`#### ${ch.badge}: ${ch.title}\n`);
    lines.push(ch.desc + '\n');
    const statusLabel = { req: '✓ required', miss: '✗ absent', opt: 'optional' };
    lines.push('**Fields:**\n');
    for (const f of ch.fields) {
      lines.push(`- \`${f.name}\`: ${f.val} (${statusLabel[f.status]})`);
    }
    lines.push('');
  }

  lines.push('#### Processing Engine Steps\n');
  for (const s of proc.ENGINE_STEPS) {
    lines.push(`${s.num}. **${s.name}:** ${s.desc}`);
  }
  lines.push(hr());

  // HS Code Resolution
  lines.push(`## ${proc.HS_CODE_SECTION.num}. ${proc.HS_CODE_SECTION.label}\n`);
  lines.push(`### ${proc.HS_CODE_SECTION.title}\n`);
  lines.push(proc.HS_CODE_SECTION.desc + '\n');

  lines.push('### HS Code Quality Breakdown\n');
  lines.push(table(
    ['Category', 'Count', '%'],
    proc.HS_QUALITY_ROWS.map(r => [r.label, r.count, r.pct])
  ));
  lines.push('');

  lines.push('### Resolution Algorithm\n');
  for (const step of proc.ALGO_STEPS) {
    lines.push(`#### Step ${step.num}: ${step.title}\n`);
    lines.push(step.desc + '\n');
    if (step.searchKeys) {
      lines.push('Search keys: ' + step.searchKeys.map(k => `\`${k}\``).join(' → ') + '\n');
    }
  }

  lines.push('### Edge Cases\n');
  for (const w of proc.WARNINGS) {
    lines.push(`**⚠ ${w.tag}:**`);
    lines.push(w.body + '\n');
  }
  lines.push(hr());

  // AI Opportunities
  lines.push('## AI Opportunities\n');
  lines.push('### What happens today — and where AI changes it\n');
  for (const row of proc.AI_OPPORTUNITIES) {
    lines.push(`#### ${row.pct}: ${row.title}\n`);
    lines.push(`**Today:** ${row.today}\n`);
    lines.push(`**AI opportunity:** ${row.ai}\n`);
  }
  lines.push(hr());

  // ZATCA XML
  lines.push(`## ${proc.ZATCA_SECTION.num}. ${proc.ZATCA_SECTION.label}\n`);
  lines.push(`### ${proc.ZATCA_SECTION.title}\n`);
  lines.push(proc.ZATCA_SECTION.desc + '\n');
  lines.push('**Field source legend:** client, derived, fixed, mapped\n');
  for (const sec of proc.ZATCA_SECTIONS) {
    lines.push(`#### ${sec.name}\n`);
    lines.push(`\`${sec.tag}\`\n`);
    for (const f of sec.fields) {
      lines.push(`- \`${f.name}\`: ${f.value} *(${f.source})*`);
    }
    lines.push('');
  }

  // Worked Example
  lines.push('### Worked Example\n');
  lines.push(`${proc.WORKED_EXAMPLE.title}\n`);
  lines.push(`**Client sends:** \`${proc.WORKED_EXAMPLE.clientSends.code}\` — ${proc.WORKED_EXAMPLE.clientSends.note}\n`);
  lines.push(`**Step 1 — Clean:** \`${proc.WORKED_EXAMPLE.step1.from}\` → \`${proc.WORKED_EXAMPLE.step1.to}\` (${proc.WORKED_EXAMPLE.step1.note})\n`);
  lines.push(`**Step 2 — Search keys:** ${proc.WORKED_EXAMPLE.searchKeys.map(k => `\`${k}\``).join(', ')}\n`);
  lines.push('**Steps 3 & 4 — Lookup & pick best:**\n');
  lines.push(table(
    ['ZATCA 12-digit', 'Arabic description', 'Duty', 'Matched key'],
    proc.WORKED_EXAMPLE.lookupRows.map(r => [
      r.picked ? `**${r.code}**` : r.code,
      r.desc,
      r.duty,
      r.picked ? `**${r.key}**` : r.key,
    ])
  ));
  lines.push(`\n${proc.WORKED_EXAMPLE.lookupNote}\n`);
  lines.push(`**Result:** tariffCode: \`${proc.WORKED_EXAMPLE.result.tariffCode}\`, goodsDescription: ${proc.WORKED_EXAMPLE.result.goodsDescription}\n`);
  lines.push(`> ${proc.WORKED_EXAMPLE.result.badge}\n`);
  lines.push(`*${proc.WORKED_EXAMPLE.completeCodeNote}*`);

  return lines.join('\n');
}

function generateArchitecture(): string {
  const lines: string[] = [];

  lines.push(`# ${arch.PAGE.chapter}`);
  lines.push(`## ${arch.PAGE.pageTitle}\n`);
  lines.push(arch.PAGE.hero.lede);
  lines.push(hr());

  lines.push(`## ${arch.SYSTEM_ARCH.title}\n`);
  lines.push(arch.SYSTEM_ARCH.desc + '\n');
  lines.push(hr());

  // Algorithm
  lines.push(`## Section ${arch.ALGORITHM.sectionLabel}: ${arch.ALGORITHM.sectionName}\n`);
  lines.push(`### ${arch.ALGORITHM.title}\n`);
  lines.push(arch.ALGORITHM.desc + '\n');
  lines.push(`### ${arch.ALGORITHM.rationale.title}\n`);
  lines.push(arch.ALGORITHM.rationale.intro + '\n');
  for (const p of arch.ALGORITHM.rationale.points) {
    lines.push(`**${p.heading}**`);
    lines.push(p.body);
    if (p.code) lines.push(`\`\`\`\n${p.code}\n\`\`\``);
    lines.push('');
  }
  lines.push(hr());

  // Deployment
  lines.push(`## Section ${arch.DEPLOYMENT.sectionLabel}: ${arch.DEPLOYMENT.sectionName}\n`);
  lines.push(`### ${arch.DEPLOYMENT.title}\n`);
  lines.push(arch.DEPLOYMENT.desc + '\n');
  lines.push(`### ${arch.DEPLOYMENT.rationale.title}\n`);
  lines.push(arch.DEPLOYMENT.rationale.intro + '\n');
  for (const p of arch.DEPLOYMENT.rationale.points) {
    lines.push(`**${p.heading}**`);
    lines.push(p.body);
    if (p.code) lines.push(`\`\`\`\n${p.code}\n\`\`\``);
    lines.push('');
  }
  lines.push(hr());

  // V2
  lines.push(`## ${arch.V2.title}\n`);
  lines.push(arch.V2.desc + '\n');
  lines.push('**Planned components:**\n');
  for (const item of arch.V2.plannedItems) lines.push(`- ${item}`);

  return lines.join('\n');
}

function generateReference(): string {
  const lines: string[] = [];

  lines.push(`# ${ref.PAGE.chapter}`);
  lines.push(`## ${ref.PAGE.pageTitle}\n`);
  lines.push(ref.PAGE.hero.lede);
  lines.push(`\n**SharePoint Folder:** [Sample Data & Resources](${ref.PAGE.sharepointLink})`);
  lines.push(hr());

  // HS Anatomy
  lines.push(`## ${ref.HS_ANATOMY.num}. ${ref.HS_ANATOMY.label}\n`);
  lines.push(`### Saudi HS Code ${ref.HS_ANATOMY.titleAccent}\n`);
  lines.push(ref.HS_ANATOMY.desc + '\n');
  lines.push('**Structure:**\n');
  for (const l of ref.HS_ANATOMY.layers) lines.push(`- **${l.label}** (${l.sub}): \`${l.digits}\``);
  lines.push(`- **${ref.HS_ANATOMY.gcc.label}** (${ref.HS_ANATOMY.gcc.sub}): \`${ref.HS_ANATOMY.gcc.digits}\``);
  lines.push(`- **${ref.HS_ANATOMY.saudi.label}** (${ref.HS_ANATOMY.saudi.sub}): \`${ref.HS_ANATOMY.saudi.digits}\``);
  lines.push(`\n**Example:** \`${ref.HS_ANATOMY.example.code}\` — ${ref.HS_ANATOMY.example.display}\n`);
  lines.push('**Legend:**\n');
  for (const l of ref.HS_ANATOMY.legend) lines.push(`- ${l}`);
  lines.push(hr());

  // Authorities
  lines.push(`## ${ref.AUTHORITIES_SECTION.num}. ${ref.AUTHORITIES_SECTION.label}\n`);
  lines.push(`### Who sets the ${ref.AUTHORITIES_SECTION.titleAccent}\n`);
  lines.push(ref.AUTHORITIES_SECTION.desc + '\n');
  for (const a of ref.AUTHORITIES) {
    lines.push(`#### ${a.abbr}: ${a.name}\n`);
    lines.push(`*${a.sub}*\n`);
    lines.push(`**What it does:** ${a.does}\n`);
    lines.push(`**Clear AI relevance:** ${a.relevance}\n`);
    if (a.note) lines.push(`> **Note:** ${a.note}\n`);
  }
  lines.push(hr());

  // GRI Rules
  lines.push(`## ${ref.GRI_SECTION.num}. ${ref.GRI_SECTION.label}\n`);
  lines.push(`### Classification ${ref.GRI_SECTION.titleAccent}\n`);
  lines.push(ref.GRI_SECTION.desc + '\n');
  for (const r of ref.GRI_RULES) {
    lines.push(`#### ${r.id}: ${r.label}\n`);
    lines.push(r.body + '\n');
  }
  lines.push(`**Reference document:** [${ref.GRI_SECTION.referenceDoc}](${ref.GRI_SECTION.referenceLink})\n`);
  lines.push(hr());

  // Sources
  lines.push(`## ${ref.SOURCES_SECTION.num}. ${ref.SOURCES_SECTION.label}\n`);
  lines.push(`### Where the logic ${ref.SOURCES_SECTION.titleAccent}\n`);
  lines.push(ref.SOURCES_SECTION.desc + '\n');
  for (const s of ref.SOURCE_TYPES) {
    lines.push(`#### ${s.label}: ${s.title}\n`);
    lines.push(s.body + '\n');
  }

  return lines.join('\n');
}

// ── Main ──
function main() {
  const docsDir = path.resolve(__dirname, '../../docs');

  // Ensure directory exists
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const files = [
    { name: '01-product-definition.md', content: generateProductDefinition() },
    { name: '02-process.md',            content: generateProcess() },
    { name: '03-architecture.md',       content: generateArchitecture() },
    { name: '04-reference.md',          content: generateReference() },
  ];

  for (const f of files) {
    const filePath = path.join(docsDir, f.name);
    fs.writeFileSync(filePath, f.content, 'utf-8');
    console.log(`✓ Generated ${f.name}`);
  }

  console.log(`\nDone — ${files.length} markdown files written to ${docsDir}`);
}

main();
