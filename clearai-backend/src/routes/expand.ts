import type { FastifyInstance } from 'fastify';
import { expandBody } from './schemas.js';
import { retrieveCandidates } from '../retrieval/retrieve.js';
import { loadThresholds, isEnabled } from '../catalog/setup-meta.js';
import { evaluateGate } from '../classification/evidence-gate.js';
import { llmPick } from '../classification/llm-pick.js';
import { resolve } from '../classification/resolve.js';
import { logEvent } from '../observability/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';
import { getPool } from '../db/client.js';
import { lookupBrokerMapping } from '../classification/broker-mapping.js';
import { round4 } from '../util/score.js';
import { withRequestId, baseModelInfo, trimAlternativeDashes, trimCatalogDashes } from './_helpers.js';
import { sanitiseRationale } from '../util/sanitise.js';
import { getDeletionInfo } from '../catalog/deleted-codes.js';

export async function expandRoute(app: FastifyInstance): Promise<void> {
  app.post('/classifications/expand', async (req, reply) => {
    const t0 = Date.now();
    const parse = expandBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parse.error.flatten() });
    }
    const { code: parentPrefix, description } = parse.data;
    const lang = detectLang(description);

    // ── SABER deletion guard ─────────────────────────────────────────────────
    // Check BEFORE retrieval. If the caller submitted a prefix that exactly
    // matches a deleted 12-digit code, refuse and surface alternatives so the
    // broker can pick the correct replacement (Option A — see ADR-0021).
    // 10-digit or shorter prefixes are never deleted directly; only 12-digit
    // leaves get the SABER treatment, so this guard only fires on full codes.
    if (parentPrefix.length === 12) {
      const deletion = await getDeletionInfo(parentPrefix);
      if (deletion) {
        const totalLatency = Date.now() - t0;
        const requestId = await logEvent({
          endpoint: 'expand',
          request: { code: parentPrefix, description },
          languageDetected: lang,
          decisionStatus: 'needs_clarification',
          decisionReason: 'code_deleted',
          confidenceBand: null,
          chosenCode: null,
          alternatives: deletion.alternatives.map((a) => ({
            code: a.code,
            description_en: a.description_en,
            description_ar: a.description_ar,
            retrieval_score: null,
          })),
          topRetrievalScore: 0,
          top2Gap: 0,
          candidateCount: 0,
          branchSize: null,
          llmUsed: false,
          llmStatus: null,
          guardTripped: false,
          modelCalls: null,
          embedderVersion: EMBEDDER_VERSION(),
          llmModel: null,
          totalLatencyMs: totalLatency,
          error: null,
          rationale: null,
        }, req.log);

        return {
          ...withRequestId(requestId),
          decision_status: 'needs_clarification' as const,
          decision_reason: 'code_deleted' as const,
          deleted_code: parentPrefix,
          deletion_effective_date: deletion.deletionEffectiveDate,
          deleted_code_alternatives: trimAlternativeDashes(
            deletion.alternatives.map((a) => ({
              code: a.code,
              description_en: a.description_en,
              description_ar: a.description_ar,
              retrieval_score: null,
            })),
          ),
          alternatives: [],
          model: baseModelInfo(),
        };
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const t = await loadThresholds();

    // Tenant-override short-circuit — trust the per-tenant curated table over retrieval+LLM.
    if (isEnabled(t, 'TENANT_OVERRIDES_ENABLED')) {
      const hit = await lookupBrokerMapping(parentPrefix);
      if (hit) {
        // Defense in depth: a curated broker-mapping row may point to a code
        // that ZATCA/SABER has since deleted. Refuse with the deleted-code
        // envelope rather than serve the dead target.
        const targetDeletion = await getDeletionInfo(hit.targetCode);
        if (targetDeletion) {
          const totalLatency = Date.now() - t0;
          const requestId = await logEvent({
            endpoint: 'expand',
            request: {
              code: parentPrefix,
              description,
              broker_mapping_hit: true,
              broker_mapping_target_deleted: hit.targetCode,
            },
            languageDetected: lang,
            decisionStatus: 'needs_clarification',
            decisionReason: 'code_deleted',
            confidenceBand: null,
            chosenCode: null,
            alternatives: targetDeletion.alternatives.map((a) => ({
              code: a.code,
              description_en: a.description_en,
              description_ar: a.description_ar,
              retrieval_score: null,
            })),
            topRetrievalScore: 0,
            top2Gap: 0,
            candidateCount: 0,
            branchSize: null,
            llmUsed: false,
            llmStatus: null,
            guardTripped: false,
            modelCalls: null,
            embedderVersion: EMBEDDER_VERSION(),
            llmModel: null,
            totalLatencyMs: totalLatency,
            error: null,
            rationale: null,
          }, req.log);

          return {
            ...withRequestId(requestId),
            decision_status: 'needs_clarification' as const,
            decision_reason: 'code_deleted' as const,
            deleted_code: hit.targetCode,
            deletion_effective_date: targetDeletion.deletionEffectiveDate,
            deleted_code_alternatives: trimAlternativeDashes(
              targetDeletion.alternatives.map((a) => ({
                code: a.code,
                description_en: a.description_en,
                description_ar: a.description_ar,
                retrieval_score: null,
              })),
            ),
            alternatives: [],
            model: baseModelInfo(),
          };
        }

        const pool = getPool();
        const catRes = await pool.query<{
          description_en: string | null;
          description_ar: string | null;
        }>(
          `SELECT description_en, description_ar FROM hs_codes WHERE code = $1`,
          [hit.targetCode],
        );
        const cat = catRes.rows[0] ?? null;
        const totalLatency = Date.now() - t0;
        const brokerMappingRationale = `Broker-curated mapping: merchant code ${hit.matchedClientCode} routes to ${hit.targetCode} per the operations team's hand-curated lookup.`;

        const requestId = await logEvent({
          endpoint: 'expand',
          request: {
            code: parentPrefix,
            description,
            broker_mapping_hit: true,
            broker_mapping_matched_length: hit.matchedLength,
            broker_mapping_source_row: hit.sourceRowRef,
          },
          languageDetected: lang,
          decisionStatus: 'accepted',
          decisionReason: 'strong_match',
          confidenceBand: 'high',
          chosenCode: hit.targetCode,
          alternatives: [],
          topRetrievalScore: 1,
          top2Gap: 1,
          candidateCount: 0,
          branchSize: null,
          llmUsed: false,
          llmStatus: null,
          guardTripped: false,
          modelCalls: null,
          embedderVersion: EMBEDDER_VERSION(),
          llmModel: null,
          totalLatencyMs: totalLatency,
          error: null,
          rationale: brokerMappingRationale,
        }, req.log);

        return {
          ...withRequestId(requestId),
          decision_status: 'accepted' as const,
          decision_reason: 'strong_match' as const,
          confidence_band: 'high' as const,
          before: { code: parentPrefix },
          after: {
            code: hit.targetCode,
            description_en: trimCatalogDashes(cat?.description_en ?? null),
            // Broker AR has the phrasing they actually submit.
            description_ar: trimCatalogDashes(
              hit.targetDescriptionAr ?? cat?.description_ar ?? null,
            ),
            retrieval_score: null,
          },
          alternatives: [],
          rationale: brokerMappingRationale,
          broker_mapping: {
            matched_client_code: hit.matchedClientCode,
            matched_length: hit.matchedLength,
            source_row_ref: hit.sourceRowRef,
          },
          model: baseModelInfo(),
        };
      }
    }

    const pool = getPool();
    const branchCountRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM hs_codes WHERE is_leaf = true AND code LIKE $1`,
      [`${parentPrefix}%`]
    );
    const branchSize = Number(branchCountRes.rows[0]?.count ?? 0);

    if (branchSize === 0) {
      const totalLatency = Date.now() - t0;
      const requestId = await logEvent({
        endpoint: 'expand',
        request: { code: parentPrefix, description },
        languageDetected: lang,
        decisionStatus: 'needs_clarification',
        decisionReason: 'invalid_prefix',
        confidenceBand: null,
        chosenCode: null,
        alternatives: [],
        topRetrievalScore: 0,
        top2Gap: 0,
        candidateCount: 0,
        branchSize: 0,
        llmUsed: false,
        llmStatus: null,
        guardTripped: false,
        modelCalls: null,
        embedderVersion: EMBEDDER_VERSION(),
        llmModel: null,
        totalLatencyMs: totalLatency,
        error: null,
        rationale: null,
      }, req.log);
      return {
        ...withRequestId(requestId),
        decision_status: 'needs_clarification',
        decision_reason: 'invalid_prefix',
        alternatives: [],
        model: baseModelInfo(),
      };
    }

    const candidates = await retrieveCandidates(description, {
      leavesOnly: true,
      prefixFilter: parentPrefix,
      topK: 12,
    });

    const gate = evaluateGate(candidates, {
      minScore: t.MIN_SCORE_expand,
      minGap: t.MIN_GAP_expand,
    });

    // Single-descendant: accept the lone leaf without an LLM call.
    const singleValidDescendant = branchSize === 1;
    let llm = null;
    if (gate.passed && !singleValidDescendant && candidates.length > 0) {
      llm = await llmPick({
        kind: 'expand',
        query: description,
        candidates: candidates.slice(0, 8),
        parentPrefix,
        model: env().LLM_MODEL,
      });
    }

    let chosenCode: string | null = null;
    if (singleValidDescendant && gate.passed) {
      chosenCode = candidates[0]?.code ?? null;
    }

    const decision = resolve({
      gate,
      llm,
      ...(singleValidDescendant && chosenCode ? { singleValidDescendant: true } : {}),
    });

    if (singleValidDescendant && chosenCode && gate.passed) {
      decision.chosenCode = chosenCode;
      decision.decisionStatus = 'accepted';
      decision.decisionReason = 'single_valid_descendant';
    }

    const alternatives = trimAlternativeDashes(
      candidates.slice(0, 5).map((c) => ({
        code: c.code,
        description_en: c.description_en,
        description_ar: c.description_ar,
        retrieval_score: round4(c.rrf_score),
      })),
    );

    const totalLatency = Date.now() - t0;

    const requestId = await logEvent({
      endpoint: 'expand',
      request: { code: parentPrefix, description },
      languageDetected: lang,
      decisionStatus: decision.decisionStatus,
      decisionReason: decision.decisionReason,
      confidenceBand: decision.confidenceBand ?? null,
      chosenCode: decision.chosenCode,
      alternatives,
      topRetrievalScore: gate.topRetrievalScore,
      top2Gap: gate.top2Gap,
      candidateCount: candidates.length,
      branchSize,
      llmUsed: !!llm,
      llmStatus: llm?.llmStatus ?? null,
      guardTripped: llm?.guardTripped ?? false,
      modelCalls: llm
        ? [{ model: llm.llmModel, latency_ms: llm.latencyMs, status: llm.llmStatus }]
        : null,
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: llm?.llmModel ?? null,
      totalLatencyMs: totalLatency,
      error: null,
      // Phase 2.3: sanitise the picker-emitted rationale before persist.
      // Same function applied to the response below so persisted == shipped.
      rationale: sanitiseRationale(decision.rationale ?? null),
    }, req.log);

    const sanitisedRationale = sanitiseRationale(decision.rationale);
    return {
      ...withRequestId(requestId),
      decision_status: decision.decisionStatus,
      decision_reason: decision.decisionReason,
      ...(decision.confidenceBand && { confidence_band: decision.confidenceBand }),
      ...(decision.chosenCode && (() => {
        const chosen = candidates.find((c) => c.code === decision.chosenCode);
        return {
          before: { code: parentPrefix },
          after: {
            code: decision.chosenCode,
            description_en: trimCatalogDashes(chosen?.description_en ?? null),
            description_ar: trimCatalogDashes(chosen?.description_ar ?? null),
            retrieval_score: round4(chosen?.rrf_score ?? 0),
          },
        };
      })()),
      alternatives,
      ...(sanitisedRationale && { rationale: sanitisedRationale }),
      ...(decision.missingAttributes.length > 0 && { missing_attributes: decision.missingAttributes }),
      model: baseModelInfo(llm?.llmModel ?? null),
    };
  });
}
