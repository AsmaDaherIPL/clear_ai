/**
 * ClassifyWorkbench — thin wrapper around ClassifyApp.
 *
 * Previously this hosted a single/batch lane switch. Batch processing is
 * not part of the v1 Fastify backend, so the lane switch is removed and
 * this component is now a passthrough. Kept as a separate file so the
 * page-level mount point doesn't change and we have a place to add
 * future cross-cutting concerns (auth gate, feature flags, etc.).
 */
import ClassifyApp from './ClassifyApp';

export default function ClassifyWorkbench() {
  return <ClassifyApp />;
}
