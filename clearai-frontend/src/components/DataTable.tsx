/**
 * Headless table primitive — TanStack Table v8 + TanStack Virtual v3.
 *
 * Features:
 *   - Row virtualisation (overscan 10) via @tanstack/react-virtual
 *   - Sticky <thead> inside the scroll container
 *   - Optional global search (setGlobalFilter)
 *   - Optional per-column filter chips
 *   - Column visibility toggle — shadcn DropdownMenuCheckboxItem menu
 *   - Column resizing — TanStack onColumnSizingChange, drag handle on <th>
 *   - Persistence — columnVisibility + columnSizing stored in localStorage
 *     under the key `dt-prefs:<tableId>` so operator preferences survive
 *     page reloads without any backend round-trip.
 *   - Skeleton-row tail while expectedRowCount > data.length
 *   - Empty state
 *   - onRowClick + rowClassName hooks
 *
 * Width ownership:
 *   Resizing requires inline style={{ width }} on every <th> and <td>.
 *   Column widths are driven entirely by TanStack's columnSizing state
 *   (initial values come from each column def's `size` / `minSize` /
 *   `maxSize` fields). The old Tailwind width utilities on meta.cellClassName
 *   are gone — those were a static-layout workaround incompatible with
 *   user-resizable columns.
 *
 * tableId stability:
 *   The `tableId` prop must be stable for the component's lifetime (mount it
 *   with `key={tableId}` if it can ever change). Changing tableId mid-mount
 *   would merge the old prefs into the new table's key — use `key` on the
 *   parent to force a full remount instead.
 */
import {
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  type ColumnSizingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------

interface TablePrefs {
  columnVisibility: VisibilityState;
  columnSizing: ColumnSizingState;
}

function loadPrefs(tableId: string): Partial<TablePrefs> {
  try {
    const raw = localStorage.getItem(`dt-prefs:${tableId}`);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<TablePrefs>;
  } catch {
    return {};
  }
}

function savePrefs(tableId: string, prefs: TablePrefs): void {
  try {
    localStorage.setItem(`dt-prefs:${tableId}`, JSON.stringify(prefs));
  } catch {
    // Quota exceeded or private browsing — silent no-op.
  }
}

/**
 * Debounce saves so rapid resize drags don't spam localStorage.
 * The timer ref is stable across renders; its cleanup is implicit
 * (the pending save fires after unmount which is harmless — it only
 * writes to localStorage, never reads React state).
 */
function useDebouncedSave(tableId: string, delay = 400) {
  const timerRef = useRef<number | null>(null);
  return useCallback(
    (prefs: TablePrefs) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => savePrefs(tableId, prefs), delay);
    },
    [tableId, delay],
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FilterChipGroup {
  columnId: string;
  label: string;
  options: { label: string; value?: unknown }[];
}

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];

  /**
   * Stable identifier for this table instance. Used as the localStorage
   * key suffix for persisting column visibility and sizing prefs.
   * Must be stable for the component's lifetime — if it can change,
   * mount the parent with `key={tableId}` to force a full remount.
   * e.g. "batch-results-v1"
   */
  tableId: string;

  estimatedRowHeight: number;

  expectedRowCount?: number;
  renderSkeletonRow?: (i: number) => ReactNode;

  searchPlaceholder?: string;
  enableGlobalSearch?: boolean;

  filterChips?: FilterChipGroup;

  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;

  maxHeight?: string;
  emptyState?: ReactNode;

  className?: string;
}

// ---------------------------------------------------------------------------
// Column resizer — pure Tailwind, no bespoke component.
// A thin drag handle at the inline-end edge of each resizable <th>.
// Handler prop typed as (e: unknown) => void to match TanStack's actual
// getResizeHandler() return type (DOM events, not React synthetic events).
// ---------------------------------------------------------------------------

interface ResizerProps {
  onPointerDown: (e: unknown) => void;
  isResizing: boolean;
}

function ColumnResizer({ onPointerDown, isResizing }: ResizerProps) {
  return (
    <div
      onMouseDown={onPointerDown as React.MouseEventHandler}
      onTouchStart={onPointerDown as React.TouchEventHandler}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className={cn(
        'absolute end-0 top-0 h-full w-[5px] cursor-col-resize touch-none select-none',
        'flex items-center justify-center',
        'after:block after:h-4 after:w-px after:rounded-full',
        isResizing
          ? 'after:bg-[var(--ink-2)] opacity-100'
          : 'after:bg-[var(--line)] opacity-0 hover:opacity-100',
        'transition-opacity duration-100',
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

export function DataTable<T extends object>({
  data,
  columns,
  tableId,
  estimatedRowHeight,
  expectedRowCount,
  renderSkeletonRow,
  searchPlaceholder = 'Search…',
  enableGlobalSearch = false,
  filterChips,
  onRowClick,
  rowClassName,
  maxHeight = 'max-h-[640px]',
  emptyState,
  className,
}: DataTableProps<T>) {
  // -------------------------------------------------------------------------
  // State — load persisted prefs on first render only.
  // -------------------------------------------------------------------------
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    return loadPrefs(tableId).columnVisibility ?? {};
  });

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    return loadPrefs(tableId).columnSizing ?? {};
  });

  // -------------------------------------------------------------------------
  // Persist on user-driven changes (debounced).
  // Guard: skip the first effect run on mount to avoid clobbering prefs that
  // were loaded above with an immediate re-save of the initial empty state.
  // -------------------------------------------------------------------------
  const debouncedSave = useDebouncedSave(tableId);
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    debouncedSave({ columnVisibility, columnSizing });
  }, [columnVisibility, columnSizing, debouncedSave]);

  // -------------------------------------------------------------------------
  // TanStack Table instance.
  // -------------------------------------------------------------------------
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, columnVisibility, columnSizing },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    // onChange gives live feedback during drag. Switch to 'onEnd' if
    // drag performance degrades on very large datasets.
    columnResizeMode: 'onChange',
  });

  const realRows = table.getRowModel().rows;

  const filtersActive = globalFilter.length > 0 || columnFilters.length > 0;
  const skeletonCount =
    expectedRowCount && !filtersActive && data.length < expectedRowCount
      ? expectedRowCount - data.length
      : 0;

  const totalRows = realRows.length + skeletonCount;

  // -------------------------------------------------------------------------
  // Virtualiser.
  // -------------------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  // -------------------------------------------------------------------------
  // Filter-chip helpers.
  // -------------------------------------------------------------------------
  const activeChipValue = useMemo(() => {
    if (!filterChips) return undefined;
    const f = columnFilters.find((cf) => cf.id === filterChips.columnId);
    return f?.value;
  }, [columnFilters, filterChips]);

  const setChip = (value: unknown) => {
    if (!filterChips) return;
    if (value === undefined) {
      setColumnFilters((prev) => prev.filter((cf) => cf.id !== filterChips.columnId));
    } else {
      setColumnFilters((prev) => {
        const others = prev.filter((cf) => cf.id !== filterChips.columnId);
        return [...others, { id: filterChips.columnId, value }];
      });
    }
  };

  // -------------------------------------------------------------------------
  // Columns toggle list — only columns with a string header can be listed
  // meaningfully (function headers have no display name for the menu).
  // -------------------------------------------------------------------------
  const toggleableColumns = table
    .getAllColumns()
    .filter((col) => col.getCanHide() && typeof col.columnDef.header === 'string');

  const showEmptyState = data.length === 0 && !expectedRowCount;

  // -------------------------------------------------------------------------
  // Render.
  // -------------------------------------------------------------------------
  return (
    <div className={cn('flex flex-col', className)}>
      {/* Toolbar: search + filter chips + columns toggle */}
      {(enableGlobalSearch || filterChips || toggleableColumns.length > 0) && (
        <div className="px-[22px] py-3 flex items-center gap-3 flex-wrap border-b border-[var(--line-2)]">
          {enableGlobalSearch && (
            <input
              type="search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className={cn(
                'flex-1 min-w-[200px] max-w-[360px] px-3 py-1.5 rounded-md',
                'bg-[var(--line-2)] border border-transparent text-[13px] text-[var(--ink)]',
                'placeholder:text-[var(--ink-3)]',
                'focus:outline-none focus:border-[var(--ink-3)] focus:bg-[var(--surface)]',
                'transition-colors duration-150',
              )}
              aria-label={searchPlaceholder}
            />
          )}

          {filterChips && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.06em] uppercase me-1">
                {filterChips.label}
              </span>
              {filterChips.options.map((opt) => {
                const active =
                  opt.value === activeChipValue ||
                  (opt.value === undefined && activeChipValue === undefined);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setChip(opt.value)}
                    className={cn(
                      'inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-colors duration-150',
                      active
                        ? 'bg-[var(--ink)] border-[var(--ink)] text-[var(--bg)]'
                        : 'bg-[var(--surface)] border-[var(--line)] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
                    )}
                    style={active ? { color: 'var(--bg)' } : undefined}
                    aria-pressed={active}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Columns visibility toggle — shadcn DropdownMenu */}
          {toggleableColumns.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'ms-auto h-8 gap-1.5 border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                    'hover:bg-[var(--line-2)] hover:text-[var(--ink)] hover:border-[var(--ink-3)]',
                    'font-mono text-[11px] uppercase tracking-[0.06em]',
                    '[&_svg]:size-3',
                  )}
                >
                  <Settings2 aria-hidden />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(
                  'min-w-[180px] border-[var(--line)] bg-[var(--surface)]',
                  'text-[var(--ink)] text-[13px]',
                )}
              >
                <DropdownMenuLabel className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.06em] uppercase px-2 py-1.5">
                  Show / hide columns
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-[var(--line-2)]" />
                {toggleableColumns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    // Radix CheckedState is boolean | "indeterminate".
                    // toggleVisibility expects boolean — coerce explicitly.
                    onCheckedChange={(checked) => col.toggleVisibility(checked === true)}
                    className="text-[13px]"
                  >
                    {String(col.columnDef.header)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* Table scroll container */}
      <div ref={scrollRef} className={cn('overflow-auto relative', maxHeight)}>
        {/*
          tableLayout: fixed + width driven by getTotalSize() — required for
          TanStack column resizing. Individual column widths are set via
          style={{ width: header.getSize() }} on each <th>/<td>.
          Note: position:relative on <th> inside border-collapse is supported
          in modern browsers. If Safari shows a collapsed bottom border during
          scroll, switch to border-separate / border-spacing: 0.
        */}
        <table
          className="w-full border-collapse"
          style={{ tableLayout: 'fixed', width: table.getTotalSize() }}
        >
          <thead className="sticky top-0 z-10 bg-[var(--line-2)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  const isResizing = header.column.getIsResizing();
                  // Bind resize handler once per header to avoid duplicate
                  // allocations and to ensure both mouse/touch get the same ref.
                  const resizeHandler = header.getResizeHandler();
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize(), position: 'relative' }}
                      className={cn(
                        'text-start px-3.5 py-3 border-b border-[var(--line)] font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase select-none align-middle',
                      )}
                      aria-sort={
                        sortDir === 'asc'
                          ? 'ascending'
                          : sortDir === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                    >
                      {/* Sort trigger wraps only the label span, not the resizer */}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 overflow-hidden',
                          canSort && 'cursor-pointer hover:text-[var(--ink-2)]',
                        )}
                        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        // Prevent a zero-distance drag from firing a sort click
                        onMouseDown={(e) => isResizing && e.preventDefault()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && (
                          <span className="text-[var(--ink-3)] shrink-0" aria-hidden>
                            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '·'}
                          </span>
                        )}
                      </span>
                      {/* Resize handle — only on resizable columns */}
                      {header.column.getCanResize() && (
                        <ColumnResizer
                          isResizing={isResizing}
                          onPointerDown={resizeHandler}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {showEmptyState ? (
              <tr>
                <td
                  colSpan={table.getVisibleLeafColumns().length}
                  className="px-3.5 py-12 text-center text-[13px] text-[var(--ink-3)] italic"
                >
                  {emptyState ?? 'No data.'}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 && (
                  <tr style={{ height: paddingTop }} aria-hidden>
                    <td colSpan={table.getVisibleLeafColumns().length} />
                  </tr>
                )}
                {virtualItems.map((vi) => {
                  const isReal = vi.index < realRows.length;
                  if (isReal) {
                    const row = realRows[vi.index];
                    const original = row.original;
                    const extraCls = rowClassName ? rowClassName(original) : '';
                    return (
                      <tr
                        key={row.id}
                        data-index={vi.index}
                        ref={virtualizer.measureElement}
                        onClick={onRowClick ? () => onRowClick(original) : undefined}
                        className={cn(
                          'border-b border-[var(--line-2)] align-top',
                          onRowClick && 'cursor-pointer hover:bg-[var(--line-2)]',
                          extraCls,
                        )}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            style={{ width: cell.column.getSize() }}
                            className="px-3.5 py-2.5 align-top overflow-hidden"
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    );
                  }
                  // Skeleton row — spans full colSpan, independent of sizing
                  const skeletonIndex = vi.index - realRows.length;
                  return (
                    <tr
                      key={`skeleton-${vi.index}`}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="border-b border-[var(--line-2)] align-top"
                    >
                      <td colSpan={table.getVisibleLeafColumns().length} className="p-0">
                        {renderSkeletonRow ? (
                          renderSkeletonRow(skeletonIndex)
                        ) : (
                          <div className="px-3.5 py-2.5 h-[40px] flex items-center">
                            <span className="h-3 w-1/2 bg-[var(--line-2)] animate-pulse rounded" />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {paddingBottom > 0 && (
                  <tr style={{ height: paddingBottom }} aria-hidden>
                    <td colSpan={table.getVisibleLeafColumns().length} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
