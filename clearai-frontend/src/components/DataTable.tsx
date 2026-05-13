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
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  type ColumnSizingState,
  type PaginationState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Settings2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Pagination — sentinel for "show all rows" (disables pagination row model).
// We pick a deliberately huge number so TanStack does not slice the data.
// ---------------------------------------------------------------------------
const PAGE_SIZE_ALL = Number.MAX_SAFE_INTEGER;
const PAGE_SIZE_OPTIONS: { label: string; value: number }[] = [
  { label: '15', value: 15 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'All', value: PAGE_SIZE_ALL },
];
const DEFAULT_PAGE_SIZE = 50;

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

  /**
   * Default column visibility map applied on first mount when no user
   * preferences are persisted yet. Once the user has toggled any column
   * via the Columns dropdown, the persisted state takes over and this
   * default is ignored. Use this to ship a column "off by default" while
   * still letting power users opt in.
   *
   * Example: `{ value_plausibility_verdict: false }` — column exists,
   * lives in the Columns menu, but isn't rendered until the user enables it.
   */
  defaultColumnVisibility?: VisibilityState;

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
  // Discoverability: idle state shows a faint divider hairline (always
  // visible) so users see resizing is possible. Hover bumps it darker
  // and to a 2px-wide column. Active drag goes accent. Hit zone is 8px
  // wide so the cursor doesn't have to land on a 1px line.
  return (
    <div
      onMouseDown={onPointerDown as React.MouseEventHandler}
      onTouchStart={onPointerDown as React.TouchEventHandler}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className={cn(
        'group absolute end-0 top-0 h-full w-[8px] cursor-col-resize touch-none select-none',
        'flex items-center justify-center',
        'after:block after:h-[60%] after:rounded-full after:transition-all after:duration-100',
        isResizing
          ? 'after:w-[2px] after:bg-[var(--accent)] after:h-full'
          : 'after:w-px after:bg-[var(--line)] hover:after:w-[2px] hover:after:bg-[var(--ink-3)]',
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
  defaultColumnVisibility,
  estimatedRowHeight,
  expectedRowCount,
  renderSkeletonRow,
  searchPlaceholder = 'Search…',
  enableGlobalSearch = false,
  filterChips,
  onRowClick,
  rowClassName,
  maxHeight,
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
    const persisted = loadPrefs(tableId).columnVisibility;
    // Persisted prefs (if any) ALWAYS win — once the user toggles a column
    // we honour that choice forever. defaultColumnVisibility only applies
    // on the very first mount (no prefs yet in localStorage), so first-time
    // users see columns marked default-off as hidden while still being able
    // to toggle them on via the Columns menu.
    if (persisted) return persisted;
    return defaultColumnVisibility ?? {};
  });

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    return loadPrefs(tableId).columnSizing ?? {};
  });

  // Pagination state — page size is user-controlled; pageIndex resets to 0
  // whenever data length changes (e.g. a new batch run begins polling).
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
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

  // Clamp pageIndex when the underlying data shrinks (e.g. filters narrow the
  // result set below the current page boundary, or a new batch run resets
  // items to []). Without this guard, the footer can show "Page 5 of 2"
  // briefly until the user clicks a nav button.
  useEffect(() => {
    if (pagination.pageSize >= PAGE_SIZE_ALL) return;
    const maxPageIndex = Math.max(
      0,
      Math.ceil(data.length / pagination.pageSize) - 1,
    );
    if (pagination.pageIndex > maxPageIndex) {
      setPagination((p) => ({ ...p, pageIndex: maxPageIndex }));
    }
  }, [data.length, pagination.pageIndex, pagination.pageSize]);

  // -------------------------------------------------------------------------
  // TanStack Table instance.
  // -------------------------------------------------------------------------
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnSizing,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableColumnResizing: true,
    // onChange gives live feedback during drag. Switch to 'onEnd' if
    // drag performance degrades on very large datasets.
    columnResizeMode: 'onChange',
  });

  const realRows = table.getRowModel().rows;

  // Skeleton tail logic. The tail is rendered ONLY on the last page (or in
  // "All" mode) so it represents not-yet-arrived rows from the backend.
  // On non-last pages there's no missing tail to show — the full page is
  // already populated.
  const filtersActive = globalFilter.length > 0 || columnFilters.length > 0;
  const isAllPage = pagination.pageSize >= PAGE_SIZE_ALL;
  const pageCount = table.getPageCount();
  const onLastPage = isAllPage || pagination.pageIndex >= pageCount - 1;
  const skeletonCount =
    expectedRowCount && !filtersActive && onLastPage && data.length < expectedRowCount
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

  // Clear any active chip filter when its target column is hidden via the
  // Columns dropdown. Otherwise a hidden column could keep filtering the
  // visible set with no UI to surface or undo the filter.
  const chipColumnVisible = filterChips
    ? table.getColumn(filterChips.columnId)?.getIsVisible() ?? true
    : true;
  useEffect(() => {
    if (!filterChips || chipColumnVisible) return;
    setColumnFilters((prev) => prev.filter((cf) => cf.id !== filterChips.columnId));
  }, [chipColumnVisible, filterChips]);

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

          {/*
            Filter chips are gated on the target column being visible.
            Showing chips that filter a hidden column would let users click
            "Pass" and see rows disappear without understanding why.
          */}
          {filterChips && table.getColumn(filterChips.columnId)?.getIsVisible() && (
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

          {/*
            Columns visibility toggle MOVED to the footer next to the
            page-size picker — see the footer block below. Toolbar here
            keeps only the search input and verdict filter chips so the
            top of the table reads as filtering controls and the bottom
            reads as view controls. Less visual noise either way.
          */}
        </div>
      )}

      {/* Table scroll container */}
      <div ref={scrollRef} className={cn('overflow-auto relative', maxHeight)}>
        {/*
          Responsive width strategy:
            - width: 100% — the table always fills its container.
            - tableLayout: fixed — column widths from <th> style={{ width }}
              are treated as proportional hints; the browser distributes
              container width across columns in the same ratio as those hints.
              When the user drags a resize handle, TanStack updates the per-
              column `size`; the ratios change, the total stays at 100%.
            - No minWidth — that would force a horizontal scrollbar whenever
              the sum of column sizes exceeds container width. We want the
              table to fill width with normal padding, not scroll.
          Individual column widths are set via style={{ width }} on each <th>
          only; <td> cells inherit via tableLayout: fixed.
        */}
        <table
          className="border-collapse"
          style={{ tableLayout: 'fixed', width: '100%' }}
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
                        'text-start px-[18px] py-3.5 border-b border-[var(--line)] font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.10em] uppercase select-none align-middle',
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
                          // Subtle hover — cream/bg tone, not line-2 (too dark).
                          // Matches the Landing Page batch reference's #FBFAF7 hover.
                          'hover:bg-[oklch(0.985_0.006_70)] transition-colors duration-100',
                          onRowClick && 'cursor-pointer',
                          extraCls,
                        )}
                      >
                        {row.getVisibleCells().map((cell) => (
                          // tableLayout: fixed makes <td> inherit width
                          // from the matching <th>, so no inline width here.
                          <td
                            key={cell.id}
                            className="px-[18px] py-[18px] align-top overflow-hidden"
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

      {/*
        Pagination footer — row counter + page-size picker only.
        Virtualization is the primary scroll affordance, so prev/next page
        buttons are deliberately omitted (they'd be redundant click-through
        cost on top of free scroll). The page-size cap exists as a comfort
        affordance: at 300+ items the user can choose to render only the
        first 50 rather than measuring every row on initial paint.
        - Only renders when there are real rows (skeleton-only state hides it).
        - "Showing X-Y of Z" honours active filters (e.g. "276 filtered out").
        - Page size "All" sets pageSize to MAX_SAFE_INTEGER → single page,
          equivalent to pure virtualization with no truncation.
      */}
      {realRows.length > 0 && (() => {
        const filteredCount = table.getFilteredRowModel().rows.length;
        const totalCount = data.length;
        const filteredOut = totalCount - filteredCount;
        const pageIndex = table.getState().pagination.pageIndex;
        const pageSize = table.getState().pagination.pageSize;
        const isAll = pageSize >= PAGE_SIZE_ALL;
        const fromRow = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
        const toRow = Math.min((pageIndex + 1) * pageSize, filteredCount);
        const currentSizeLabel =
          PAGE_SIZE_OPTIONS.find((o) => o.value === pageSize)?.label ?? String(pageSize);
        return (
          <div className="flex items-center justify-between gap-3 px-[22px] py-3 border-t border-[var(--line-2)] bg-[var(--line-2)] flex-wrap">
            {/* Row count summary */}
            <div className="text-[12.5px] text-[var(--ink-2)] tabular-nums">
              {isAll ? (
                <>
                  Showing{' '}
                  <span className="text-[var(--ink)] font-medium">{filteredCount}</span>
                  {' '}of{' '}
                  <span className="text-[var(--ink)] font-medium">{totalCount}</span>
                  {filteredOut > 0 && (
                    <span className="text-[var(--ink-3)] ms-1.5">
                      ({filteredOut} filtered out)
                    </span>
                  )}
                </>
              ) : (
                <>
                  Showing{' '}
                  <span className="text-[var(--ink)] font-medium">
                    {fromRow}-{toRow}
                  </span>
                  {' '}of{' '}
                  <span className="text-[var(--ink)] font-medium">{filteredCount}</span>
                  {filteredOut > 0 && (
                    <span className="text-[var(--ink-3)] ms-1.5">
                      ({filteredOut} filtered out)
                    </span>
                  )}
                </>
              )}
            </div>

            {/*
              View controls cluster — page size picker + columns visibility.
              Both buttons are deliberately small and subdued (ghost-style,
              sentence case, no uppercase shouting) so they read as "view
              options" rather than primary actions. The actual primary
              action (Start a new batch) lives in the panel header.
            */}
            <div className="flex items-center gap-1">
              {/* Page size picker */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-7 px-2.5 gap-1.5 text-[12px] font-normal',
                      'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
                      '[&_svg]:size-3',
                    )}
                  >
                    Show {currentSizeLabel}
                    <ChevronDown aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="min-w-[140px] border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] text-[13px]"
                >
                  <DropdownMenuLabel className="text-[11.5px] text-[var(--ink-3)] px-2 py-1.5 font-normal">
                    Rows per page
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-[var(--line-2)]" />
                  <DropdownMenuRadioGroup
                    value={String(pageSize)}
                    onValueChange={(value) => {
                      const next = Number(value);
                      table.setPageSize(next);
                      table.setPageIndex(0);
                    }}
                  >
                    {PAGE_SIZE_OPTIONS.map((opt) => (
                      <DropdownMenuRadioItem
                        key={opt.value}
                        value={String(opt.value)}
                        className="text-[13px]"
                      >
                        {opt.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Columns visibility — moved from top toolbar */}
              {toggleableColumns.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'h-7 px-2.5 gap-1.5 text-[12px] font-normal',
                        'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--line-2)]',
                        '[&_svg]:size-3',
                      )}
                    >
                      <Settings2 aria-hidden />
                      Columns
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-[200px] border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] text-[13px]"
                  >
                    <DropdownMenuLabel className="text-[11.5px] text-[var(--ink-3)] px-2 py-1.5 font-normal">
                      Show / hide columns
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator className="bg-[var(--line-2)]" />
                    {toggleableColumns.map((col) => (
                      <DropdownMenuCheckboxItem
                        key={col.id}
                        checked={col.getIsVisible()}
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
          </div>
        );
      })()}
    </div>
  );
}
