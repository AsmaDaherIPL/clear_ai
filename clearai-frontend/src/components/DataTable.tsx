/**
 * Headless table primitive — TanStack Table + TanStack Virtual.
 *
 * Reusable foundation for the batch results table (this PR) and a
 * future HITL review queue (separate PR, /hitl + /hitl/:itemId).
 *
 * Owns:
 *   - useReactTable wiring (core, sorted, filtered row models)
 *   - Row virtualization via @tanstack/react-virtual (overscan: 10)
 *   - Sticky <thead> via position: sticky inside the scroll container
 *   - Optional global search input wired to table.setGlobalFilter
 *   - Optional filter chips wired to per-column setFilterValue
 *   - Skeleton-row tail when expectedRowCount > data.length
 *   - Empty state when data.length === 0 && !expectedRowCount
 *   - onRowClick + rowClassName hooks (HITL master-detail will use both)
 *
 * Deliberately does NOT own:
 *   - Row expansion / inline detail
 *   - Row selection / checkboxes
 *   - Column resizing, reordering, visibility persistence
 *   - Bulk actions / pagination controls
 *   - Drawer state (HITL is master-detail across routes, not in-table)
 *
 * Performance target: at 7,400 rows the rendered DOM should hold
 * < 100 row nodes during scroll (windowed by the virtualizer).
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

export interface FilterChipGroup {
  /** id of the column to filter on (must match a ColumnDef.id). */
  columnId: string;
  /** Group label rendered before the chips, e.g. "Status". */
  label: string;
  /**
   * Chip options. `value: undefined` (or omitted) clears the filter
   * — used for the "All" chip.
   */
  options: { label: string; value?: unknown }[];
}

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];

  /** Estimated row height for virtualizer (px). Real heights are measured via ResizeObserver. */
  estimatedRowHeight: number;

  /**
   * When provided AND data.length < expectedRowCount, render skeleton
   * rows for the missing tail. Used by BatchResultsTable while items
   * are still classifying.
   */
  expectedRowCount?: number;
  renderSkeletonRow?: (i: number) => ReactNode;

  /** Global search across all string/number columns. */
  searchPlaceholder?: string;
  enableGlobalSearch?: boolean;

  /** Filter chips above the table. */
  filterChips?: FilterChipGroup;

  /** Row interaction hooks — used by future HITL master-detail navigation. */
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;

  /** Layout. */
  maxHeight?: string;
  emptyState?: ReactNode;

  className?: string;
}

/**
 * Generic-component generic functions need a `<T,>` (with the comma)
 * to disambiguate from JSX in TSX. The exported component below is a
 * wrapper that preserves the generic.
 */
export function DataTable<T extends object>({
  data,
  columns,
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
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const realRows = table.getRowModel().rows;

  // Skeleton tail count — only render when no global filter / no
  // column filter is active (filtering against a partial dataset is
  // confusing; skeletons should disappear once the user starts
  // searching). When all rows have arrived (or none expected),
  // skeletonCount is 0 and the tail block disappears entirely.
  const filtersActive = globalFilter.length > 0 || columnFilters.length > 0;
  const skeletonCount =
    expectedRowCount && !filtersActive && data.length < expectedRowCount
      ? expectedRowCount - data.length
      : 0;

  const totalRows = realRows.length + skeletonCount;

  // Virtualizer — measures real row heights via the ref callback so
  // tall rows (Code Breakdown is ~90px, others ~40px) don't jitter on
  // scroll. overscan: 10 keeps a buffer so fast-scroll doesn't flash.
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
  const paddingBottom = virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;

  // Filter-chip helpers. The "All" chip clears the column filter; any
  // other chip sets it to the option's value.
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

  const showEmptyState = data.length === 0 && !expectedRowCount;

  return (
    <div className={cn('flex flex-col', className)}>
      {(enableGlobalSearch || filterChips) && (
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
                const active = opt.value === activeChipValue
                  || (opt.value === undefined && activeChipValue === undefined);
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
        </div>
      )}

      <div ref={scrollRef} className={cn('overflow-auto relative', maxHeight)}>
        {/*
          tableLayout: auto so cell width is governed by content +
          Tailwind classes on the cells (min-w-/max-w-/truncate). The
          fixed-layout was used previously because every column had a
          `size:` number; we've moved column sizing into the cell's
          className so we no longer need the table to enforce widths.
        */}
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-[var(--line-2)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  // headerClassName is an optional ColumnDef.meta hook the
                  // consumer can use to size the header to match the cell
                  // (Tailwind utilities only — no inline pixel widths).
                  const headerCls = (header.column.columnDef.meta as { headerClassName?: string } | undefined)
                    ?.headerClassName ?? '';
                  return (
                    <th
                      key={header.id}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      className={cn(
                        'text-start px-3.5 py-3 border-b border-[var(--line)] font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase select-none align-middle',
                        canSort && 'cursor-pointer hover:text-[var(--ink-2)]',
                        headerCls,
                      )}
                      aria-sort={
                        sortDir === 'asc' ? 'ascending' :
                        sortDir === 'desc' ? 'descending' : 'none'
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && (
                          <span className="text-[var(--ink-3)]" aria-hidden>
                            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '·'}
                          </span>
                        )}
                      </span>
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
                        {row.getVisibleCells().map((cell) => {
                          // cellClassName lets the column author Tailwind-size
                          // each cell (min-w-/max-w-/truncate) without a
                          // hardcoded pixel size on the column def.
                          const cellCls = (cell.column.columnDef.meta as { cellClassName?: string } | undefined)
                            ?.cellClassName ?? '';
                          return (
                            <td key={cell.id} className={cn('px-3.5 py-2.5 align-top', cellCls)}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  }
                  // Skeleton row (tail of expected count not yet arrived).
                  const skeletonIndex = vi.index - realRows.length;
                  return (
                    <tr
                      key={`skeleton-${vi.index}`}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="border-b border-[var(--line-2)] align-top"
                    >
                      <td colSpan={table.getVisibleLeafColumns().length} className="p-0">
                        {renderSkeletonRow ? renderSkeletonRow(skeletonIndex) : (
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
