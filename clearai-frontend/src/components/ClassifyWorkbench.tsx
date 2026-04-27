/**
 * ClassifyWorkbench — top-level mount point.
 *
 * Owns the run-mode (single | batch) so we can swap the working surface
 * without re-rendering chrome. When `single` we delegate to ClassifyApp
 * (full TopBar/Hero/ModeTabs/InputCard/results pipeline) and inject the
 * RunToggle as a slot above the InputCard. When `batch` we render the
 * same chrome ourselves and replace the working surface with the static
 * BatchLane preview — the v1 backend doesn't ship a batch endpoint yet,
 * so this is intentionally UI-only.
 *
 * Why the chrome lives here for batch: ClassifyApp embeds its own
 * TopBar/Hero/ModeTabs and is tightly coupled to the single-item state
 * machine. Cloning that chrome here is cheaper than untangling it, and
 * keeps the visual frame identical between lanes.
 */
import { useState } from 'react';
import ClassifyApp from './ClassifyApp';
import RunToggle, { type RunMode } from './RunToggle';
import BatchLane from './BatchLane';
import TopBar from './TopBar';
import Hero from './Hero';
import ModeTabs, { type Mode } from './ModeTabs';
import Footer from './Footer';

export default function ClassifyWorkbench() {
  const [runMode, setRunMode] = useState<RunMode>('single');

  if (runMode === 'single') {
    return (
      <ClassifyApp
        runToggle={<RunToggle runMode={runMode} setRunMode={setRunMode} />}
      />
    );
  }

  // Batch lane: same chrome, static batch surface. ModeTabs is rendered
  // disabled-looking via a no-op setMode + fixed mode='generate'; the user's
  // mental model in batch lane is "I'm uploading a CSV", so the per-item
  // mode pills aren't actionable here. Visually we keep them so the page
  // doesn't shift when toggling lanes.
  const noop = (_m: Mode) => { /* mode is irrelevant in batch lane */ };
  return (
    <div className="shell">
      <TopBar />
      <Hero />
      <ModeTabs mode="generate" setMode={noop} />
      <RunToggle runMode={runMode} setRunMode={setRunMode} />
      <BatchLane />
      <Footer />
    </div>
  );
}
