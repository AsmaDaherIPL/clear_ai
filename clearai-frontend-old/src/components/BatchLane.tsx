/**
 * BatchLane — UI-only batch surface.
 *
 * Renders the v5 design's `.dropzone` so users can preview the batch
 * flow even though the backend endpoint isn't shipped yet. Drag-and-drop
 * is wired locally to flip the dropzone into a `has-file` state with the
 * file name; we DO NOT POST anywhere. The CSV column-reference card was
 * removed for now — we'll bring it back (or replace with a sample-CSV
 * download link) once the batch endpoint lands and the schema is locked.
 *
 * Two distinct surfaces:
 *   1. Dropzone — accepts CSV / XLSX visually
 *   2. Coming-soon banner — explicit message that the lane is preview-only
 */
import { useRef, useState } from 'react';

export default function BatchLane() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  function pickFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setFileName(f.name);
  }

  function onClick() {
    inputRef.current?.click();
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDrag(true);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDrag(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    pickFile(e.dataTransfer.files);
  }

  return (
    <div className="batch-wrap">
      <div
        className={`dropzone${drag ? ' over' : ''}${fileName ? ' has-file' : ''}`}
        onClick={onClick}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => pickFile(e.target.files)}
        />
        <div className="drop-icon" aria-hidden>
          {/* Inline upload glyph — keeps the bundle free of an icon dep. */}
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" />
            <path d="m6 10 6-6 6 6" />
            <path d="M4 20h16" />
          </svg>
        </div>
        {fileName ? (
          <>
            <div className="drop-t">{fileName}</div>
            <div className="drop-s">Click again to replace · CSV / XLSX accepted</div>
          </>
        ) : (
          <>
            <div className="drop-t">Drop your invoice CSV here</div>
            <div className="drop-s">…or click to browse · CSV or Excel accepted</div>
          </>
        )}
        <span className="drop-cta" aria-hidden>
          Choose file
        </span>
      </div>

      <div className="batch-soon">
        <span className="batch-soon-chip">PREVIEW</span>
        <p>
          Batch processing is coming next — drop a file to see the spec, but
          submission is disabled until the v1 batch endpoint ships. Single-item
          classification works today on the lane above.
        </p>
      </div>
    </div>
  );
}
