/**
 * ResultPlaceholderCard — desktop-side scaffold before a classification runs.
 */
export default function ResultPlaceholderCard() {
  return (
    <div className="result-placeholder">
      <div className="result-placeholder-head">
        <span className="badge badge-soft">Awaiting classification</span>
        <span className="placeholder-trace mono">trace pending</span>
      </div>

      <div className="result-placeholder-code">
        <span>12</span>
        <span>34</span>
        <span>56</span>
        <span>78</span>
        <span>90</span>
        <span>12</span>
      </div>

      <p className="result-placeholder-copy">
        Submit a description or partial code to see the resolved Saudi HS output, confidence,
        explanation chain, closest competitor, and export actions together.
      </p>

      <div className="result-placeholder-list">
        <div className="placeholder-item">
          <span className="placeholder-k">Output</span>
          <span className="placeholder-v">12-digit Saudi code with grouped digits</span>
        </div>
        <div className="placeholder-item">
          <span className="placeholder-k">Review</span>
          <span className="placeholder-v">Plain-English reasoning plus Arabic support</span>
        </div>
        <div className="placeholder-item">
          <span className="placeholder-k">Scale</span>
          <span className="placeholder-v">
            Need CSV processing? <a href="/batch">Open the batch workspace</a>.
          </span>
        </div>
      </div>
    </div>
  );
}
