import { describe, it, expect } from 'vitest';
import { buildXlsx, columnLetter, crc32, excelSerial, localDateTime, safeSheetName, tzOffsetMs, unzip, xmlEscape, zip } from '../modules/agency/xlsx';

const part = (buf: Buffer, name: string) => unzip(buf).find((e) => e.name === name)?.data.toString('utf8') ?? '';

describe('xlsx writer', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('zip round-trips every entry with verified sizes and checksums (including non-ASCII names and empty files)', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
      { name: 'ünï/cödé.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
      { name: 'empty.xml', data: Buffer.alloc(0) },
    ];
    const back = unzip(zip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(back.map((e) => e.data.toString('hex'))).toEqual(entries.map((e) => e.data.toString('hex')));
  });

  it('a corrupted archive is detected, not silently read', () => {
    const z = zip([{ name: 'a.txt', data: Buffer.from('some reasonably long text some reasonably long text') }]);
    z[40] ^= 0xff; // inside the compressed payload
    expect(() => unzip(z)).toThrow();
  });

  it('builds a workbook with the standard parts, a frozen styled header, filters and named sheets', () => {
    const x = buildXlsx(
      [
        { name: 'Leads', header: ['Name', 'Value'], rows: [['Asha', 10.5]], moneyColumns: [1] },
        { name: 'Activity log', header: ['When'], rows: [[new Date('2026-01-01T00:00:00Z')]] },
      ],
      { timeZone: 'UTC' }
    );
    const names = unzip(x).map((e) => e.name).sort();
    expect(names).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expect(part(x, 'xl/workbook.xml')).toContain('<sheet name="Leads" sheetId="1" r:id="rId1"/>');
    expect(part(x, 'xl/workbook.xml')).toContain('<sheet name="Activity log" sheetId="2" r:id="rId2"/>');
    const s1 = part(x, 'xl/worksheets/sheet1.xml');
    expect(s1).toContain('state="frozen"');
    expect(s1).toContain('<autoFilter ref="A1:B2"/>');
    expect(s1).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(s1).toContain('<c r="B2" s="3"><v>10.5</v></c>'); // money style
    expect(part(x, 'xl/worksheets/sheet2.xml')).toContain('<c r="A2" s="2"><v>46023</v></c>'); // 2026-01-01 as an Excel date
  });

  it('text is inline and escaped: no cell can become a formula, XML metacharacters and control characters are neutralised', () => {
    const x = buildXlsx([{ name: 'S', header: ['Text'], rows: [['=HYPERLINK("http://evil")'], ['<b>&"x"</b>'], ['bad\u0000\u0007char'], ['  spaced  ']] }], { timeZone: 'UTC' });
    const s = part(x, 'xl/worksheets/sheet1.xml');
    expect(s).not.toContain('<f>');
    expect(s).toContain('=HYPERLINK(&quot;http://evil&quot;)</t>');
    expect(s).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
    expect(s).toContain('badchar');
    expect(s).toContain('xml:space="preserve">  spaced  </t>');
  });

  it('truncates a cell beyond the spreadsheet limit instead of producing an unreadable file', () => {
    const x = buildXlsx([{ name: 'S', header: ['T'], rows: [['a'.repeat(40_000)]] }], { timeZone: 'UTC' });
    const s = part(x, 'xl/worksheets/sheet1.xml');
    expect(s.length).toBeLessThan(33_500 + 2_000);
  });

  it('skips empty, NaN and invalid-date cells; writes booleans', () => {
    const x = buildXlsx([{ name: 'S', header: ['a', 'b', 'c', 'd', 'e'], rows: [[null, Number.NaN, new Date('nope'), true, undefined]] }], { timeZone: 'UTC' });
    const row = /<row r="2">(.*?)<\/row>/.exec(part(x, 'xl/worksheets/sheet1.xml'))![1];
    expect(row).toBe('<c r="D2" t="b"><v>1</v></c>');
  });

  it('helpers: column letters, sheet names, escaping', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
    const used = new Set<string>();
    expect(safeSheetName('Leads/2026: [all]?', used)).toBe('Leads 2026   all');
    expect(safeSheetName('leads 2026   all', used)).toBe('leads 2026   all 2'); // names are unique case-insensitively
    expect(safeSheetName('x'.repeat(50), new Set())).toHaveLength(31);
    expect(safeSheetName('   ', new Set())).toBe('Sheet');
    expect(xmlEscape('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
  });

  it('dates are converted to the requested time zone (Excel dates carry no zone)', () => {
    const d = new Date('2026-10-15T20:00:00Z');
    expect(tzOffsetMs(d, 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
    expect(tzOffsetMs(d, 'UTC')).toBe(0);
    expect(localDateTime(d, 'Asia/Kolkata')).toBe('2026-10-16 01:30'); // crosses midnight
    expect(localDateTime(d, 'America/New_York')).toBe('2026-10-15 16:00'); // daylight time
    expect(excelSerial(new Date('2026-01-01T00:00:00Z'), 'UTC')).toBe(46023);
    expect(excelSerial(new Date('2026-01-01T00:00:00Z'), 'Asia/Kolkata')).toBeCloseTo(46023 + 5.5 / 24, 8);
  });

  it('refuses an empty workbook', () => {
    expect(() => buildXlsx([], { timeZone: 'UTC' })).toThrow();
  });
});
