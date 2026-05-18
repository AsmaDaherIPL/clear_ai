/**
 * Naqel CSV row grouper (PR3).
 *
 * Takes the row-level output of `parseCsvBuffer` and groups it into the
 * customs hierarchy:
 *
 *   manifests[]
 *     └── awbs[]
 *           └── items[]
 *
 * Group keys:
 *   manifest  = (operator_slug, ManifestedTime)
 *               → when ManifestedTime is empty/absent, synthesise an id
 *                 of the form '{operator_slug}_m_{seq}' (seq = 1, 2, ...
 *                 scoped per ingest call). Rows missing ManifestedTime
 *                 collapse into a single synthetic manifest per ingest.
 *   awb       = (manifest, WayBillNo)
 *               → AWB must be present. Rows with empty WayBillNo are
 *                 rejected as a parse error.
 *   item      = each remaining row, with row_index preserved.
 *
 * Naqel column reference (25 columns, all optional except where noted):
 *   ManifestedTime, WayBillNo, InvoiceNo, ClientID, ClientName,
 *   DeclaredValue, Weight, DestinationStationID, Dest,
 *   ConsigneeNationalID, ConsigneeName, ConsigneeBirthDate, Mobile,
 *   PhoneNumber, HSCode, CustomsCommodityCode, Description, Amount,
 *   Currency, Quantity, UnitCost, UnitType, ChineseDescription,
 *   ItemWeightUnit, ItemWeightValue
 *
 * Returns a `GroupedNaqelCsv` payload with three flat arrays plus
 * back-references via deterministic temp ids. The ingest use-case turns
 * temp ids into real DB ids inside a single transaction.
 */

export class NaqelGrouperError extends Error {
  readonly code = 'naqel_grouper_error';
  constructor(message: string, readonly rowIndex: number | null) {
    super(message);
    this.name = 'NaqelGrouperError';
  }
}

/** Temp ids the grouper assigns locally so items can point at AWBs without
 *  a DB round-trip. The ingest layer maps these to real UUIDs at insert. */
export type TempManifestId = `m_${number}`;
export type TempAwbId = `awb_${number}`;

export interface GroupedManifest {
  tempId: TempManifestId;
  /** Either the verbatim ManifestedTime value or a synthesised id. */
  mawbNo: string;
  /** Parsed ManifestedTime as a Date; null when missing or unparseable. */
  manifestedAt: Date | null;
  /** True when mawbNo was synthesised; false when it came from the CSV. */
  synthesised: boolean;
}

export interface GroupedAwb {
  tempId: TempAwbId;
  manifestTempId: TempManifestId;
  awbNo: string;
  consigneeNationalId: string | null;
  consigneeName: string | null;
  consigneeMobile: string | null;
  consigneePhone: string | null;
  consigneeBirthDate: string | null;
  consigneeDest: string | null;
  consigneeDestStation: string | null;
}

export interface GroupedItem {
  /** 1-based, matches the source CSV row position (post-header). */
  rowIndex: number;
  manifestTempId: TempManifestId;
  awbTempId: TempAwbId;
  /** The verbatim raw row from the CSV — every column. */
  rawRow: Record<string, string>;
}

export interface GroupedNaqelCsv {
  manifests: GroupedManifest[];
  awbs: GroupedAwb[];
  items: GroupedItem[];
}

export interface GroupOpts {
  operatorSlug: string;
}

/**
 * Group parsed CSV rows into the manifest/AWB/item hierarchy.
 *
 * Row order is preserved: items appear in input order; manifests and
 * AWBs appear in first-seen order so the synthesised mawb_no sequence
 * matches the CSV's natural ordering.
 */
export function groupNaqelCsv(
  rows: ReadonlyArray<Record<string, string>>,
  opts: GroupOpts,
): GroupedNaqelCsv {
  const manifests: GroupedManifest[] = [];
  const awbs: GroupedAwb[] = [];
  const items: GroupedItem[] = [];

  // (manifest key) -> temp id
  const manifestIndex = new Map<string, TempManifestId>();
  // (manifest temp id + awb_no) -> temp id
  const awbIndex = new Map<string, TempAwbId>();

  // Per-ingest synthesised-manifest counter, starting at 1.
  let synthesisedSeq = 1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowIndex = i + 1;

    const awbNoRaw = (row.WayBillNo ?? '').trim();
    if (awbNoRaw.length === 0) {
      throw new NaqelGrouperError(
        `row ${rowIndex} has empty WayBillNo; every item must belong to an AWB`,
        rowIndex,
      );
    }

    // ── Manifest resolution ──
    const manifestedTimeRaw = (row.ManifestedTime ?? '').trim();
    let manifestTempId: TempManifestId;
    let mawbNo: string;
    let manifestedAt: Date | null;
    let synthesised: boolean;

    if (manifestedTimeRaw.length > 0) {
      // Real manifest. Group by the verbatim ManifestedTime string —
      // multiple rows sharing the same value land in the same manifest.
      const key = `real::${manifestedTimeRaw}`;
      const existing = manifestIndex.get(key);
      if (existing !== undefined) {
        manifestTempId = existing;
        const m = manifests.find((x) => x.tempId === manifestTempId)!;
        manifestedAt = m.manifestedAt;
        mawbNo = m.mawbNo;
        synthesised = m.synthesised;
      } else {
        manifestTempId = `m_${manifests.length + 1}`;
        manifestedAt = parseManifestedTime(manifestedTimeRaw);
        // Use ManifestedTime verbatim as the mawb_no when no separate
        // mawb column exists. This is consistent with Naqel's data
        // model where the timestamp IS the manifest identifier.
        mawbNo = manifestedTimeRaw;
        synthesised = false;
        manifests.push({ tempId: manifestTempId, mawbNo, manifestedAt, synthesised });
        manifestIndex.set(key, manifestTempId);
      }
    } else {
      // Synthesised manifest. Per the 2026-05-18 product decision, all
      // rows in one CSV that lack ManifestedTime collapse into one
      // synthetic manifest with id '{operator_slug}_m_{seq}'.
      const key = `synth::${opts.operatorSlug}`;
      const existing = manifestIndex.get(key);
      if (existing !== undefined) {
        manifestTempId = existing;
        const m = manifests.find((x) => x.tempId === manifestTempId)!;
        manifestedAt = m.manifestedAt;
        mawbNo = m.mawbNo;
        synthesised = m.synthesised;
      } else {
        manifestTempId = `m_${manifests.length + 1}`;
        mawbNo = `${opts.operatorSlug}_m_${synthesisedSeq++}`;
        manifestedAt = null;
        synthesised = true;
        manifests.push({ tempId: manifestTempId, mawbNo, manifestedAt, synthesised });
        manifestIndex.set(key, manifestTempId);
      }
    }

    // ── AWB resolution ──
    const awbKey = `${manifestTempId}::${awbNoRaw}`;
    let awbTempId = awbIndex.get(awbKey);
    if (awbTempId === undefined) {
      awbTempId = `awb_${awbs.length + 1}`;
      awbs.push({
        tempId: awbTempId,
        manifestTempId,
        awbNo: awbNoRaw,
        consigneeNationalId: nullIfEmpty(row.ConsigneeNationalID),
        consigneeName: nullIfEmpty(row.ConsigneeName),
        consigneeMobile: nullIfEmpty(row.Mobile),
        consigneePhone: nullIfEmpty(row.PhoneNumber),
        consigneeBirthDate: parseDateOnly(row.ConsigneeBirthDate),
        consigneeDest: nullIfEmpty(row.Dest),
        consigneeDestStation: nullIfEmpty(row.DestinationStationID),
      });
      awbIndex.set(awbKey, awbTempId);
    }

    items.push({
      rowIndex,
      manifestTempId,
      awbTempId,
      rawRow: row,
    });
  }

  return { manifests, awbs, items };
}

function nullIfEmpty(s: string | undefined): string | null {
  if (s === undefined) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a Naqel-style ManifestedTime. Naqel ships ISO 8601 with timezone
 * (e.g. "2026-05-12T08:30:00+03:00") and occasionally Excel-style
 * "2026-05-12 08:30:00". Returns null on failure so callers can fall back
 * to the synthesised pattern. Never throws.
 */
function parseManifestedTime(raw: string): Date | null {
  // Native Date parses ISO 8601 reliably. For Excel-style we replace
  // space with 'T' to nudge it into ISO range.
  const candidates = [raw, raw.replace(' ', 'T')];
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Parse a date-only string (YYYY-MM-DD or similar) into the canonical
 * YYYY-MM-DD form Postgres expects for `date` columns. Returns null when
 * the input is empty or unparseable.
 */
function parseDateOnly(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Already YYYY-MM-DD ?
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
