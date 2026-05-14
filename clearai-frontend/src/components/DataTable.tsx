/**
 * Generic data table — TanStack Table v8 + shadcn/ui Table primitive.
 *
 * Design language: editorial, restrained. Hairline dividers, generous row
 * padding, monospace metadata, mono uppercase headers, no heavy borders.
 *
 * Features:
 *   - Sortable columns (click header)
 *   - Global search (debounced via TanStack's getFilteredRowModel)
 *   - Optional filter chips (per-column quick filters)
 *   - Column visibility toggle (shadcn DropdownMenuCheckboxItem)
 *   - Pagination — first / prev / next / last + page-size selector
 *     (15 / 25 / 50 / 100 / All)
 *   - localStorage persistence of column visibility (keyed by tableId)
 *   - Skeleton tail when expectedRowCount > data.length
 *   - Empty state when data.length === 0
 *
 * Removed from the previous implementation (intentional):
 *   - Row virtualization — backend caps at ~2000 items per run; with the
 *     default 50-rows-per-page, the DOM never holds more than ~100 rows.
 *     Virtualization added complexity (variable row heights, scroll
 *     anchoring, terminal-tick merge logic) for a perf budget we never
 *     used. Pagination is the answer.
 *   - Column resizing — show/hide via the Columns menu covers the use case.
 *   - Column-sizing persistence — defunct without resizing.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnSizingState,
  type PaginationState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Search,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Pagination — sentinel for "show all rows" (single page, full dataset).
// ---------------------------------------------------------------------------

const PAGE_SIZE_ALL = Number.MAX_SAFE_INTEGER;
const PAGE_SIZE_OPTIONS: { label: string; value: number }[] = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'All', value: PAGE_SIZE_ALL },
];
const DEFAULT_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// localStorage persistence — column visibility only (sizing was retired).
// ---------------------------------------------------------------------------

interface TablePrefs {
  columnVisibility: VisibilityState;
  /** Per-column pixel widths from drag-resize. */
  columnSizing?: ColumnSizingState;
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
    /* quota exceeded / private mode — silent no-op */
  }
}

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
  /** id of the column this chip group filters. */
  columnId: string;
  /** Group label, e.g. "Verdict". */
  label: string;
  /** Option list. `value: undefined` clears the filter (used for the "All" chip). */
  options: { label: string; value?: unknown }[];
}

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];

  /**
   * Stable identifier for this table instance. Used as the localStorage
   * key suffix for persisting column visibility prefs. Must be stable for
   * the component's lifetime — mount the parent with `key={tableId}` if
   * it can ever change. e.g. "batch-results-v5"
   */
  tableId: string;

  /**
   * Default visibility map applied on first mount when no persisted prefs
   * exist for this tableId. Lets a column ship hidden-by-default while
   * staying toggle-able from the Columns menu.
   */
  defaultColumnVisibility?: VisibilityState;

  /**
   * When the backend hasn't shipped every row yet (mid-poll), draws
   * `expectedRowCount - data.length` skeleton rows at the tail of the
   * current page so the operator sees the run's expected size.
   */
  expectedRowCount?: number;
  renderSkeletonRow?: (i: number) => ReactNode;

  searchPlaceholder?: string;
  enableGlobalSearch?: boolean;

  filterChips?: FilterChipGroup;

  emptyState?: ReactNode;

  className?: string;
}

// ---------------------------------------------------------------------------
// Column resizer — thin drag handle at the inline-end edge of resizable <th>.
// Handler prop typed as (e: unknown) so it accepts TanStack's getResizeHandler
// return type (works for both mouse and touch).
// ---------------------------------------------------------------------------

function ColumnResizer({
  onPointerDown,
  isResizing,
}: {
  onPointerDown: (e: unknown) => void;
  isResizing: boolean;
}) {
  return (
    <div
      onMouseDown={onPointerDown as React.MouseEventHandler}
      onTouchStart={onPointerDown as React.TouchEventHandler}
      onClick={(e) => e.stopPropagation()}
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
  expectedRowCount,
  renderSkeletonRow,
  searchPlaceholder = 'Search…',
  enableGlobalSearch = false,
  filterChips,
  emptyState,
  className,
}: DataTableProps<T>) {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    const persisted = loadPrefs(tableId).columnVisibility;
    return persisted ?? defaultColumnVisibility ?? {};
  });
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    return loadPrefs(tableId).columnSizing ?? {};
  });
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  // -------------------------------------------------------------------------
  // Persistence — debounced save on visibility change, skipped on mount.
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

  // Clamp pageIndex when filtered data shrinks below current page boundary.
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
  // TanStack Table instance
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
    // onChange = live feedback during drag. Switch to 'onEnd' only if
    // perf degrades on very wide tables.
    columnResizeMode: 'onChange',
  });

  // -------------------------------------------------------------------------
  // Filter-chip helpers.
  // Note: we deliberately do NOT clear the filter when the chip column is
  // hidden. The filter chips are an independent UI affordance — hiding the
  // display column (e.g. value_plausibility_verdict) must not wipe the
  // active "Fail" or "Warn" filter the user just set.
  // -------------------------------------------------------------------------
  const activeChipValue = filterChips
    ? columnFilters.find((cf) => cf.id === filterChips.columnId)?.value
    : undefined;

  const setChip = (value: unknown) => {
    if (!filterChips) return;
    setColumnFilters((prev) => {
      const others = prev.filter((cf) => cf.id !== filterChips.columnId);
      if (value === undefined) return others;
      return [...others, { id: filterChips.columnId, value }];
    });
  };

  // -------------------------------------------------------------------------
  // Derived counts for the footer.
  // -------------------------------------------------------------------------
  const pageRows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const totalCount = data.length;
  const filteredOut = totalCount - filteredCount;
  const pageIndex = pagination.pageIndex;
  const pageSize = pagination.pageSize;
  const pageCount = table.getPageCount();
  const isAll = pageSize >= PAGE_SIZE_ALL;
  const fromRow = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const toRow = Math.min((pageIndex + 1) * pageSize, filteredCount);
  const currentSizeLabel =
    PAGE_SIZE_OPTIONS.find((o) => o.value === pageSize)?.label ?? String(pageSize);

  // -------------------------------------------------------------------------
  // Skeleton tail — only on the last page (or in "All" mode), only when
  // a target row count is known and we haven't filled it yet.
  // -------------------------------------------------------------------------
  const filtersActive = globalFilter.length > 0 || columnFilters.length > 0;
  const onLastPage = isAll || pageIndex >= pageCount - 1;
  const skeletonCount =
    expectedRowCount && !filtersActive && onLastPage && data.length < expectedRowCount
      ? expectedRowCount - data.length
      : 0;

  // -------------------------------------------------------------------------
  // Column visibility — only string-header columns are listed in the menu.
  // -------------------------------------------------------------------------
  const toggleableColumns = table
    .getAllColumns()
    .filter((col) => col.getCanHide() && typeof col.columnDef.header === 'string');

  const showEmptyState = data.length === 0 && !expectedRowCount;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className={cn('flex flex-col', className)}>
      {/* ------------------------------------------------------------- */}
      {/* Toolbar: search + verdict chips                                */}
      {/* ------------------------------------------------------------- */}
      {(enableGlobalSearch || filterChips) && (
        <div className="flex items-center gap-3 flex-wrap px-[22px] py-3 border-b border-[var(--line-2)]">
          {enableGlobalSearch && (
            <div className="relative flex-1 min-w-[200px] max-w-[420px]">
              <Search
                aria-hidden
                className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ink-3)] pointer-events-none"
              />
              <Input
                type="search"
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className={cn(
                  'h-9 ps-9 pe-3',
                  'bg-[var(--line-2)] border-transparent text-[13px] text-[var(--ink)]',
                  'placeholder:text-[var(--ink-3)]',
                  'focus-visible:ring-0 focus-visible:ring-offset-0',
                  'focus-visible:border-[var(--ink-3)] focus-visible:bg-[var(--surface)]',
                )}
              />
            </div>
          )}

          {filterChips && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase me-1">
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
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-colors duration-150',
                      active
                        ? 'bg-[var(--ink)] border-[var(--ink)] text-[var(--bg)]'
                        : 'bg-[var(--surface)] border-[var(--line)] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
                    )}
                    style={active ? { color: 'var(--bg)' } : undefined}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* Table                                                          */}
      {/* ------------------------------------------------------------- */}
      {/*
        tableLayout: fixed + width: 100% is required for column resizing.
        Cell widths are read from getSize() and applied inline. Default
        collapse layout from the shadcn Table primitive preserves the
        row-bottom borders via [&_tr]:border-b on TableHeader and our
        border-b on each body row (shadcn docs pattern).
      */}
      <Table style={{ tableLayout: 'fixed', width: '100%' }}>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sortDir = header.column.getIsSorted();
                const isResizing = header.column.getIsResizing();
                const resizeHandler = header.getResizeHandler();
                return (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize(), position: 'relative' }}
                    aria-sort={
                      sortDir === 'asc'
                        ? 'ascending'
                        : sortDir === 'desc'
                          ? 'descending'
                          : 'none'
                    }
                    className={cn(
                      'h-auto px-[18px] py-3.5 align-middle',
                      'font-mono text-[10.5px] font-medium tracking-[0.10em] uppercase text-[var(--ink-3)]',
                      'bg-[var(--line-2)] select-none',
                    )}
                  >
                    <span
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      // Block a 0-distance drag from firing a sort click
                      onMouseDown={(e) => isResizing && e.preventDefault()}
                      className={cn(
                        'inline-flex items-center gap-1.5 overflow-hidden',
                        canSort && 'cursor-pointer hover:text-[var(--ink-2)]',
                      )}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className="text-[var(--ink-3)] text-[9px] shrink-0" aria-hidden>
                          {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '·'}
                        </span>
                      )}
                    </span>
                    {header.column.getCanResize() && (
                      <ColumnResizer
                        isResizing={isResizing}
                        onPointerDown={resizeHandler}
                      />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {showEmptyState ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={table.getVisibleLeafColumns().length}
                className="px-[18px] py-12 text-center text-[13px] text-[var(--ink-3)] italic"
              >
                {emptyState ?? 'No data.'}
              </TableCell>
            </TableRow>
          ) : (
            <>
              {pageRows.map((row) => (
                <TableRow
                  key={row.id}
                  // shadcn-docs pattern: border-b from the primitive + a
                  // bright hover background. We override the default
                  // hover:bg-muted/50 with our own cream tint so it sits
                  // closer to the editorial palette.
                  className="align-top hover:bg-[oklch(0.985_0.006_70)] transition-colors duration-100"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      style={{ width: cell.column.getSize() }}
                      className="px-[18px] py-[18px] align-top overflow-hidden"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {Array.from({ length: skeletonCount }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                  <TableCell colSpan={table.getVisibleLeafColumns().length} className="p-0">
                    {renderSkeletonRow ? (
                      renderSkeletonRow(i)
                    ) : (
                      <div className="px-[18px] py-[18px] flex items-center">
                        <span className="h-3 w-1/2 bg-[var(--line-2)] animate-pulse rounded" />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </>
          )}
        </TableBody>
      </Table>

      {/* ------------------------------------------------------------- */}
      {/* Footer: row counter · page nav · page-size + columns           */}
      {/* ------------------------------------------------------------- */}
      {(pageRows.length > 0 || skeletonCount > 0) && (
        <div className="flex items-center justify-between gap-3 flex-wrap px-[22px] py-3 border-t border-[var(--line-2)] bg-[var(--line-2)]">
          {/* Row counter */}
          <div className="text-[12.5px] text-[var(--ink-2)] tabular-nums">
            {isAll ? (
              <>
                Showing{' '}
                <span className="text-[var(--ink)] font-medium">{filteredCount}</span> of{' '}
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
                </span>{' '}
                of <span className="text-[var(--ink)] font-medium">{filteredCount}</span>
                {filteredOut > 0 && (
                  <span className="text-[var(--ink-3)] ms-1.5">
                    ({filteredOut} filtered out)
                  </span>
                )}
              </>
            )}
          </div>

          {/* Controls cluster: nav · size · columns */}
          <div className="flex items-center gap-1.5">
            {/* Page nav */}
            {!isAll && pageCount > 1 && (
              <div className="flex items-center gap-0.5 me-2">
                <span className="text-[12px] text-[var(--ink-3)] tabular-nums me-2">
                  Page{' '}
                  <span className="text-[var(--ink-2)] font-medium">{pageIndex + 1}</span> of{' '}
                  <span className="text-[var(--ink-2)] font-medium">{pageCount}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 w-7 p-0',
                    'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
                    'disabled:opacity-30',
                    '[&_svg]:size-3.5',
                  )}
                  onClick={() => table.setPageIndex(0)}
                  disabled={!table.getCanPreviousPage()}
                  aria-label="First page"
                >
                  <ChevronFirst aria-hidden className="rtl:rotate-180" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 w-7 p-0',
                    'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
                    'disabled:opacity-30',
                    '[&_svg]:size-3.5',
                  )}
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  aria-label="Previous page"
                >
                  <ChevronLeft aria-hidden className="rtl:rotate-180" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 w-7 p-0',
                    'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
                    'disabled:opacity-30',
                    '[&_svg]:size-3.5',
                  )}
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  aria-label="Next page"
                >
                  <ChevronRight aria-hidden className="rtl:rotate-180" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 w-7 p-0',
                    'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
                    'disabled:opacity-30',
                    '[&_svg]:size-3.5',
                  )}
                  onClick={() => table.setPageIndex(pageCount - 1)}
                  disabled={!table.getCanNextPage()}
                  aria-label="Last page"
                >
                  <ChevronLast aria-hidden className="rtl:rotate-180" />
                </Button>
              </div>
            )}

            {/* Page size picker */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 px-2.5 gap-1.5 text-[12px] font-normal',
                    'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
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
                    table.setPageSize(Number(value));
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

            {/* Columns visibility */}
            {toggleableColumns.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-7 px-2.5 gap-1.5 text-[12px] font-normal',
                      'text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
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
      )}
    </div>
  );
}
