// Profiler (src/profiler.ts, čistá část): parsování odpovědi profilerData (objekty i plochá
// čtveřice), agregace T-stavů po řádcích, souborech a funkcích se stránkami, škála a formát čísel.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aggregateProfile, fileKey, heatLevel, parseProfile, percent, tstates } from '../../src/profiler';
import { SldInfo } from '../../src/sld';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-prof-'));
fs.writeFileSync(path.join(dir, 'test.sld'), [
    '|SLD.data.version|1',
    '||||||Z|pages.size:8192,pages.count:224,slots.count:8,slots.adr:0,8192,16384,24576,32768,40960,49152,57344',
    'main.asm|10||0|4|32768|F|main',
    'main.asm|11||0|4|32768|T|',
    'main.asm|12||0|4|32771|F|main.loop',
    'main.asm|12||0|4|32771|T|',
    'main.asm|13||0|4|32773|T|',
    'main.asm|19||0|4|33024|F|draw',
    'main.asm|20||0|4|33024|T|',
    'main.asm|21||0|4|33026|T|',
    'bank.asm|4||0|30|49152|F|bankA',
    'bank.asm|5||0|30|49152|T|',
    'bank.asm|49||0|31|49152|F|bankB',
    'bank.asm|50||0|31|49152|T|',
    'nopage.asm|1||0|-1|24576|T|',
].join('\n'));
const sld = SldInfo.load(path.join(dir, 'test.sld'));
const main = path.join(dir, 'main.asm');
const bank = path.join(dir, 'bank.asm');
const raw = {
    total: 2500,
    entries: [
        { page: 4, offset: 0, pc: 0x8000, t: 100 },
        { page: 4, offset: 3, pc: 0x8003, t: 300 },
        { page: 4, offset: 5, pc: 0x8005, t: 50 },
        { page: 4, offset: 0x100, pc: 0x8100, t: 1000 },
        { page: 30, offset: 0, pc: 0xc000, t: 200 },
        { page: 31, offset: 0, pc: 0xc000, t: 400 },
        { page: 0, offset: 0x38, pc: 0x0038, t: 150 },   // ROM: mimo zdroják
        { page: 4, offset: 7, pc: 0x8007, t: 0 },        // nulové se zahodí
        { page: 10, offset: 0, pc: 0x6000, t: 25 },      // řádek bez stránky (SLD bez zařízení)
        { page: 99, offset: 0, pc: 0xc000, t: 70 },      // stejná adresa jako banky 30/31, jiná stránka
        { page: 4, offset: 4, pc: 0x8004, t: 0 },
    ],
};
const sorted = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]);

test('parseProfile: objekty i plochá čtveřice dávají totéž, nulové záznamy pryč', () => {
    const p = parseProfile(raw);
    assert.equal(p.total, 2500);
    assert.equal(p.entries.length, 9);
    assert.deepEqual(parseProfile({ total: 2500, entries: raw.entries.flatMap((e) => [e.page, e.offset, e.pc, e.t]) }), p);
});

test('parseProfile: chybějící total = součet, vadná data, stav active', () => {
    assert.equal(parseProfile({ entries: [{ page: 1, offset: 2, pc: 3, t: 7 }] }).total, 7);
    assert.equal(parseProfile({ total: 3, entries: [{ page: 1, offset: 2, pc: 3, t: 7 }] }).total, 7, 'total nejméně součet');
    assert.deepEqual(parseProfile(undefined), { total: 0, entries: [] });
    assert.deepEqual(parseProfile({ total: 5, entries: 'x' }), { total: 5, entries: [] });
    assert.deepEqual(parseProfile({ entries: [null, 1, { page: 300, offset: 0x2001, pc: 0x10001, t: '4' }] }).entries, [{ page: 44, offset: 1, pc: 1, t: 4 }]);
    assert.deepEqual(parseProfile({ active: false, total: 0, count: 0, entries: [] }), { active: false, total: 0, entries: [] });
    assert.equal(parseProfile({ active: true, total: 9, count: 1, entries: [{ page: 1, offset: 0, pc: 0, t: 9 }] }).active, true);
});

test('aggregateProfile: řádky po souborech se stránkami, mimo zdroják, nejdražší řádek', () => {
    const s = aggregateProfile(parseProfile(raw), sld);
    const m = s.files.get(fileKey(main))!;
    assert.deepEqual(sorted(m.lines), [[11, 100], [12, 300], [13, 50], [20, 1000]]);
    assert.equal(m.t, 1450);
    assert.deepEqual(sorted(s.files.get(fileKey(bank))!.lines), [[5, 200], [50, 400]]);
    assert.deepEqual([...s.files.get(fileKey(path.join(dir, 'nopage.asm')))!.lines], [[1, 25]]);
    assert.equal(s.unmapped, 150 + 70, 'ROM a cizí stránka na stejné adrese');
    assert.equal(s.maxLine, 1000);
    assert.equal(s.total, 2500);
});

test('aggregateProfile: funkce podle globálních návěští se stránkou, seřazené od nejdražší', () => {
    const s = aggregateProfile(parseProfile(raw), sld);
    const fns = s.functions.map((f) => [f.name, f.t, f.location && path.basename(f.location.file) + ':' + f.location.line]);
    assert.deepEqual(fns, [
        ['draw', 1000, 'main.asm:20'],
        ['main', 450, 'main.asm:11'],   // main.loop patří do main
        ['bankB', 400, 'bank.asm:50'],
        ['', 245, 'nopage.asm:1'],      // bez návěští: místo = nejdražší řádek
        ['bankA', 200, 'bank.asm:5'],
    ]);
    assert.equal(s.functions.reduce((a, f) => a + f.t, 0), 2295, 'součet funkcí = součet záznamů');
});

test('aggregateProfile: locatePage má přednost před logickou adresou', () => {
    const p = parseProfile(raw);
    const viaPage = aggregateProfile(p, {
        labels: sld.labels,
        label: (n) => sld.label(n),
        locate: () => undefined,
        locatePage: (page, offset) => (page === 4 ? { file: main, line: 100 + offset } : undefined),
    });
    assert.deepEqual([...viaPage.files.get(fileKey(main))!.lines.keys()].sort((a, b) => a - b), [100, 103, 105, 356]);
    assert.equal(viaPage.unmapped, 845);
});

test('aggregateProfile bez SLD: vše mimo zdroják, jedna funkce bez návěští', () => {
    const none = aggregateProfile(parseProfile(raw), undefined);
    assert.equal(none.files.size, 0);
    assert.equal(none.unmapped, 2295);
    assert.deepEqual(none.functions.map((f) => [f.name, f.t]), [['', 2295]]);
});

test('heatLevel, percent, tstates', () => {
    assert.equal(heatLevel(0, 1000, 8), 0);
    assert.equal(heatLevel(5, 0, 8), 0);
    assert.equal(heatLevel(1, 1000, 8), 1);
    assert.equal(heatLevel(300, 1000, 8), 3);
    assert.equal(heatLevel(1000, 1000, 8), 8);
    assert.equal(heatLevel(5000, 1000, 8), 8);
    assert.equal(percent(300, 2500, 'en'), '12.0');
    assert.equal(percent(1, 3, 'cs'), '33,3');
    assert.equal(percent(1, 0), '0.0');
    assert.equal(tstates(1234567, 'en'), '1,234,567');
    assert.equal(tstates(1234.6, 'en'), '1,235');
});
