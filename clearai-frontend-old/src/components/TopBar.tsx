/**
 * TopBar — brand on the left, wiki link on the right.
 */

export default function TopBar() {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="name">Clear<span className="dot" />AI</span>
        <span className="by">
          by <a href="https://infinitepl.ai" target="_blank" rel="noreferrer">Infinite PL</a>
        </span>
      </div>
      <nav className="top-nav">
        <a href="https://clearai.pages.dev/" target="_blank" rel="noreferrer">
          Wiki <span aria-hidden>↗</span>
        </a>
      </nav>
    </div>
  );
}
