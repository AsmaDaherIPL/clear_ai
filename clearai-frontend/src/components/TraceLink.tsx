/**
 * TraceLink — small footer at the bottom of the result block linking to
 * /trace/:id where the full debug surface (model timeline, latency,
 * decision internals, feedback form) lives.
 *
 * Replaces the inline MetaPanel that previously rendered model + latency
 * on the main result page. We moved that content to the trace page per
 * Phase 4 so the main result stays focused on the broker's workflow
 * (chosen code → submission text → alternatives → done) without dev/meta
 * noise. The trace stays one click away for anyone who wants to dig in.
 *
 * Render policy:
 *   - With request_id: clickable "View full trace →" pill + the latency
 *     readout that used to live in MetaPanel.
 *   - Without request_id: the latency readout only, no link. This happens
 *     when logEvent() failed to insert (DB blip) — we don't want a broken
 *     "View full trace" link 404'ing.
 */
type Props = {
  requestId?: string | undefined;
  clientLatencyMs: number;
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export default function TraceLink({ requestId, clientLatencyMs }: Props) {
  return (
    <div className="trace-link-bar">
      <div className="trace-link-meta" title="Wall-clock from request submission to response.">
        Round-trip: <span className="trace-link-meta-v">{fmtMs(clientLatencyMs)}</span>
      </div>
      {requestId ? (
        <a
          className="trace-link-cta"
          href={`/trace/${requestId}`}
          title="Inspect retrieval, picker, model timeline, and submit feedback."
        >
          View full trace
          <span aria-hidden> →</span>
        </a>
      ) : (
        <span className="trace-link-cta trace-link-cta-disabled" title="Trace logging unavailable for this request.">
          Trace unavailable
        </span>
      )}
    </div>
  );
}
