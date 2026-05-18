import { describe, expect, it } from 'vitest';
import {
  groupNaqelCsv,
  NaqelGrouperError,
} from '../../../src/modules/batches/parsers/naqel-csv.grouper.js';

function r(over: Record<string, string>): Record<string, string> {
  // Minimal Naqel row with sensible defaults; tests override.
  return {
    ManifestedTime: '',
    WayBillNo: '',
    ConsigneeName: '',
    ConsigneeNationalID: '',
    Mobile: '',
    PhoneNumber: '',
    ConsigneeBirthDate: '',
    Description: '',
    Amount: '',
    Currency: '',
    Quantity: '',
    ...over,
  };
}

describe('groupNaqelCsv — manifest grouping', () => {
  it('groups rows sharing a ManifestedTime into one manifest', () => {
    const rows = [
      r({ ManifestedTime: '2026-05-12T08:30:00+03:00', WayBillNo: 'AWB-1' }),
      r({ ManifestedTime: '2026-05-12T08:30:00+03:00', WayBillNo: 'AWB-2' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.manifests).toHaveLength(1);
    expect(out.manifests[0]!.mawbNo).toBe('2026-05-12T08:30:00+03:00');
    expect(out.manifests[0]!.synthesised).toBe(false);
    expect(out.manifests[0]!.manifestedAt).toBeInstanceOf(Date);
    expect(out.awbs).toHaveLength(2);
  });

  it('puts rows with different ManifestedTime into separate manifests', () => {
    const rows = [
      r({ ManifestedTime: '2026-05-12T08:30:00+03:00', WayBillNo: 'AWB-1' }),
      r({ ManifestedTime: '2026-05-13T09:00:00+03:00', WayBillNo: 'AWB-2' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.manifests).toHaveLength(2);
    expect(out.manifests.map((m) => m.mawbNo)).toEqual([
      '2026-05-12T08:30:00+03:00',
      '2026-05-13T09:00:00+03:00',
    ]);
  });

  it('synthesises a single manifest when ManifestedTime is absent', () => {
    const rows = [
      r({ WayBillNo: 'AWB-1' }),
      r({ WayBillNo: 'AWB-2' }),
      r({ WayBillNo: 'AWB-3' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.manifests).toHaveLength(1);
    expect(out.manifests[0]!.synthesised).toBe(true);
    expect(out.manifests[0]!.mawbNo).toBe('naqel_m_1');
    expect(out.manifests[0]!.manifestedAt).toBeNull();
  });

  it('mixes synthetic + real manifests in one batch correctly', () => {
    const rows = [
      r({ WayBillNo: 'AWB-1' }), // -> synthetic
      r({ ManifestedTime: '2026-05-12T08:30:00+03:00', WayBillNo: 'AWB-2' }),
      r({ WayBillNo: 'AWB-3' }), // -> same synthetic
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.manifests).toHaveLength(2);
    expect(out.manifests[0]!.synthesised).toBe(true);
    expect(out.manifests[0]!.mawbNo).toBe('naqel_m_1');
    expect(out.manifests[1]!.synthesised).toBe(false);
  });
});

describe('groupNaqelCsv — AWB grouping', () => {
  it('groups rows sharing (manifest, WayBillNo) into one AWB', () => {
    const rows = [
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1', Description: 'item a' }),
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1', Description: 'item b' }),
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1', Description: 'item c' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.awbs).toHaveLength(1);
    expect(out.items).toHaveLength(3);
    expect(out.items.every((i) => i.awbTempId === out.awbs[0]!.tempId)).toBe(true);
  });

  it('same AWB number under different manifests stays separate', () => {
    // Per the customs spec, AWB numbers are unique within a manifest but
    // may collide across manifests (in practice they don't, but the
    // grouper must respect manifest scope).
    const rows = [
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-COMMON' }),
      r({ ManifestedTime: 'M2', WayBillNo: 'AWB-COMMON' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.awbs).toHaveLength(2);
    expect(out.awbs[0]!.manifestTempId).not.toBe(out.awbs[1]!.manifestTempId);
  });

  it('captures consignee fields from the FIRST row of each AWB', () => {
    const rows = [
      r({
        ManifestedTime: 'M1',
        WayBillNo: 'AWB-1',
        ConsigneeNationalID: '1234567890',
        ConsigneeName: 'Asma',
        Mobile: '+966500000001',
        PhoneNumber: '+966110000001',
      }),
      r({
        ManifestedTime: 'M1',
        WayBillNo: 'AWB-1',
        // Second item — these should be ignored at the AWB level.
        ConsigneeNationalID: '9999999999',
        ConsigneeName: 'wrong',
      }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.awbs[0]!.consigneeNationalId).toBe('1234567890');
    expect(out.awbs[0]!.consigneeName).toBe('Asma');
    expect(out.awbs[0]!.consigneeMobile).toBe('+966500000001');
    expect(out.awbs[0]!.consigneePhone).toBe('+966110000001');
  });

  it('handles empty consignee fields as null', () => {
    const rows = [r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1' })];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.awbs[0]!.consigneeNationalId).toBeNull();
    expect(out.awbs[0]!.consigneeName).toBeNull();
  });

  it('throws when a row has empty WayBillNo', () => {
    const rows = [
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1' }),
      r({ ManifestedTime: 'M1', WayBillNo: '   ' }), // whitespace only
    ];
    expect(() => groupNaqelCsv(rows, { operatorSlug: 'naqel' })).toThrow(NaqelGrouperError);
  });
});

describe('groupNaqelCsv — item ordering + linkage', () => {
  it('preserves input order and stamps 1-based rowIndex', () => {
    const rows = [
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1', Description: 'first' }),
      r({ ManifestedTime: 'M1', WayBillNo: 'AWB-2', Description: 'second' }),
      r({ ManifestedTime: 'M2', WayBillNo: 'AWB-3', Description: 'third' }),
    ];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.items.map((i) => i.rowIndex)).toEqual([1, 2, 3]);
    expect(out.items.map((i) => i.rawRow.Description)).toEqual(['first', 'second', 'third']);
  });

  it('each item points at its AWB and manifest by temp id', () => {
    const rows = [r({ ManifestedTime: 'M1', WayBillNo: 'AWB-1' })];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    const item = out.items[0]!;
    expect(item.manifestTempId).toBe(out.manifests[0]!.tempId);
    expect(item.awbTempId).toBe(out.awbs[0]!.tempId);
  });

  it('returns the verbatim raw row in items[].rawRow', () => {
    const row1 = r({
      ManifestedTime: 'M1',
      WayBillNo: 'AWB-1',
      Description: 'Boston Wire Buckle Nubuck',
      Amount: '300',
      Currency: 'SAR',
      HSCode: '640510',
    });
    const out = groupNaqelCsv([row1], { operatorSlug: 'naqel' });
    expect(out.items[0]!.rawRow).toEqual(row1);
  });
});

describe('groupNaqelCsv — synthetic manifest seqno', () => {
  it('synthetic seqno is per ingest, starting at 1, and shared across rows', () => {
    const rows = [r({ WayBillNo: 'AWB-1' }), r({ WayBillNo: 'AWB-2' })];
    const out = groupNaqelCsv(rows, { operatorSlug: 'naqel' });
    expect(out.manifests).toHaveLength(1);
    expect(out.manifests[0]!.mawbNo).toBe('naqel_m_1');
  });

  it('uses the operator_slug in the synthetic id', () => {
    const rows = [r({ WayBillNo: 'AWB-1' })];
    const out = groupNaqelCsv(rows, { operatorSlug: 'aramex' });
    expect(out.manifests[0]!.mawbNo).toBe('aramex_m_1');
  });
});
