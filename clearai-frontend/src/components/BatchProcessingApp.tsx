/**
 * BatchProcessingApp — batch XML pipeline UI.
 *
 * Flow:
 *   1. User drops (or picks) an .xlsx/.xls/.csv. POST /api/batch/upload.
 *   2. Backend parses + persists rows, returns job id + row count.
 *   3. "Start run" → POST /api/batch/{id}/run → backend submits to the
 *      Anthropic Batches API and begins polling.
 *   4. We poll GET /api/batch/{id} every 4 s until state === 'done'.
 *   5. Download ZIP via /api/batch/{id}/download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Footer from './Footer';
import TopBar from './TopBar';
import {
  ApiError,
  api,
  type BatchState,
  type BatchStatusResponse,
} from '../lib/api';

type Phase = 'idle' | 'uploading' | 'uploaded' | 'running' | 'done' | 'error';

const POLL_MS = 4000;
const ACCEPT_EXT = /\.(xlsx|xls|csv)$/i;
const ACCEPT_ATTR = '.xlsx,.xls,.csv';

export default function BatchProcessingApp() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<BatchStatusResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimer = useRef<number | null>(null);

  const clearPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchStatus = useCallback(
    async (id: string) => {
      try {
        const s = await api.batchStatus(id);
        setStatus(s);
        if (s.state === 'done') {
          setPhase('done');
          clearPolling();
        } else if (s.state === 'failed') {
          setPhase('error');
          setErrorMsg(s.error ?? 'Batch run failed.');
          clearPolling();
        }
      } catch (e) {
        console.warn('batch status poll failed', e);
      }
    },
    [clearPolling],
  );

  useEffect(() => () => clearPolling(), [clearPolling]);

  const handleFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (!ACCEPT_EXT.test(f.name)) {
      setErrorMsg('Unsupported format. Upload an .xlsx, .xls, or .csv file.');
      setPhase('error');
      return;
    }
    setFile(f);
    setErrorMsg(null);
    setPhase('uploading');
    try {
      const res = await api.batchUpload(f);
      setJobId(res.job_id);
      setStatus({
        job_id: res.job_id,
        state: 'pending',
        row_count: res.row_count,
        completed_count: 0,
        flagged_count: 0,
        anthropic_batch_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        input_filename: res.input_filename,
        output_zip_available: false,
        error: null,
        rows: [],
      });
      setPhase('uploaded');
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `Upload failed (${e.status}): ${e.message}`
          : 'Upload failed. Is the backend running on :8787?';
      setErrorMsg(msg);
      setPhase('error');
    }
  }, []);

  const handleStartRun = useCallback(async () => {
    if (!jobId) return;
    setPhase('running');
    setErrorMsg(null);
    try {
      const res = await api.batchRun(jobId);
      setStatus((s) =>
        s ? { ...s, state: res.state, anthropic_batch_id: res.anthropic_batch_id } : s,
      );
      clearPolling();
      await fetchStatus(jobId);
      pollTimer.current = window.setInterval(() => fetchStatus(jobId), POLL_MS);
    } catch (e) {
      const msg = e instanceof ApiError ? `Run failed (${e.status}): ${e.message}` : 'Run failed.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [jobId, fetchStatus, clearPolling]);

  const handleReset = useCallback(() => {
    clearPolling();
    setPhase('idle');
    setFile(null);
    setJobId(null);
    setStatus(null);
    setErrorMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [clearPolling]);

  // Drag handlers — preventDefault on every drag event the browser fires at the
  // dropzone, otherwise the browser will navigate to the file on drop.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear when leaving the dropzone itself, not its children.
    if (e.currentTarget === e.target) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  };

  const progressPct = useMemo(() => {
    if (!status || status.row_count === 0) return 0;
    if (status.state === 'done') return 100;
    if (status.state === 'finalizing') return 85;
    if (status.state === 'running') return 55;
    if (status.state === 'submitting') return 15;
    return 5;
  }, [status]);

  const downloadHref = useMemo(
    () => (jobId ? api.batchDownloadUrl(jobId) : '#'),
    [jobId],
  );

  return (
    <div className="shell">
      <TopBar />

      <div className="hero">
        <h1>Process customs <span className="accent">in batches</span>.</h1>
        <p className="sub">
          Drop an .xlsx, .xls, or .csv sheet. Every row is classified against
          ZATCA's 12-digit tariff and packaged as SaudiEDI XML with a review
          queue alongside.
        </p>
      </div>

      <div className="card batch-card">
        <div className="batch-head">
          <div>
            <div className="batch-kicker">Batch intake</div>
            <div className="batch-title">Drop your commercial invoice</div>
          </div>
          <span className={`batch-badge ${badgeClass(phase, status?.state)}`}>
            {phaseLabel(phase, status?.state)}
          </span>
        </div>

        <div
          className={`dropzone ${dragActive ? 'is-drag' : ''} ${file ? 'has-file' : ''}`}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          aria-label="Drop an Excel or CSV file here, or click to browse"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(e) => handleFiles(e.target.files)}
            style={{ display: 'none' }}
          />
          {file ? (
            <div className="dz-body">
              <div className="dz-file">{file.name}</div>
              <div className="dz-sub">
                {humanSize(file.size)} · {status?.row_count ?? '…'} rows parsed
              </div>
            </div>
          ) : (
            <div className="dz-body">
              <div className="dz-title">
                Drop <strong>.xlsx</strong>, <strong>.xls</strong>, or <strong>.csv</strong> here
              </div>
              <div className="dz-sub">or click to browse · up to ~1000 line items per batch</div>
            </div>
          )}
        </div>

        {errorMsg && (
          <div className="batch-err" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="batch-actions">
          <a className="pill" href="/">← Back to single item</a>
          <div className="batch-actions-r">
            <button
              className="pill"
              type="button"
              onClick={handleReset}
              disabled={phase === 'idle' || phase === 'uploading'}
            >
              Reset
            </button>
            {phase === 'done' ? (
              <a className="btn-classify" href={downloadHref}>
                Download ZIP
              </a>
            ) : (
              <button
                className="btn-classify"
                type="button"
                onClick={handleStartRun}
                disabled={phase !== 'uploaded'}
              >
                {phase === 'running' ? 'Running…' : 'Start run'}
              </button>
            )}
          </div>
        </div>
      </div>

      {status && (
        <div className="card batch-card">
          <div className="batch-head">
            <div>
              <div className="batch-kicker">Live run</div>
              <div className="batch-title">
                {jobId ? (
                  <>Batch <span className="mono">{jobId.slice(0, 8)}…</span></>
                ) : 'No active run'}
              </div>
            </div>
            <span className={`batch-badge ${badgeClass(phase, status.state)}`}>
              {stateLabel(status.state)}
            </span>
          </div>

          <div className="batch-stats">
            <div><span className="k">Rows</span><span className="v">{status.row_count}</span></div>
            <div><span className="k">Resolved</span><span className="v">{status.completed_count}</span></div>
            <div><span className="k">Flagged</span><span className="v">{status.flagged_count}</span></div>
          </div>

          <div className="batch-bar">
            <div className="fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}

function phaseLabel(phase: Phase, state?: BatchState): string {
  if (phase === 'uploading') return 'Uploading';
  if (phase === 'uploaded') return 'Ready';
  if (phase === 'running') return state ? stateLabel(state) : 'Running';
  if (phase === 'done') return 'Done';
  if (phase === 'error') return 'Error';
  return 'Idle';
}

function stateLabel(s: BatchState): string {
  switch (s) {
    case 'pending': return 'Pending';
    case 'submitting': return 'Submitting';
    case 'running': return 'Running';
    case 'finalizing': return 'Finalizing';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
  }
}

function badgeClass(phase: Phase, state?: BatchState): string {
  if (phase === 'error' || state === 'failed') return 'is-err';
  if (phase === 'done' || state === 'done') return 'is-ok';
  if (phase === 'running' || state === 'running' || state === 'submitting' || state === 'finalizing') return 'is-live';
  return '';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
