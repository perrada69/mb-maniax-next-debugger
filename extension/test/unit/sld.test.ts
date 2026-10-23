// Ladicí informace ze sjasmplus (src/sld.ts): parsování SLD, řádky ↔ adresy se stránkami,
// návěští, klíčová slova v komentářích, codeAddresses, locatePage, parseWpmem / parseLogpoint.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLogpoint, parseWpmem, SldInfo } from '../../src/sld';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-sld-'));
const sldPath = path.join(dir, 'test.sld');
fs.writeFileSync(sldPath, [
    '|SLD.data.version|1',
    '||K|KEYWORDS|WPMEM,LOGPOINT,ASSERTION',
    'main.asm|1||0|-1|-1|Z|pages.size:8192,pages.count:224,slots.count:8,slots.adr:0,8192,16384,24576,32768,40960,49152,57344',
    'main.asm|10||0|4|32768|F|main',
    'main.asm|10||0|4|32768|L|,main,',
    'main.asm|11||0|4|32768|T|',
    'main.asm|12||0|4|32771|F|main.loop',
    'main.asm|12||0|4|32771|T|',
    'main.asm|12||0|4|32771|K|; LOGPOINT [GRP] A=${A:hex}',
    'main.asm|13||0|4|32773|K|; ASSERTION A < 5',
    'main.asm|13||0|4|32773|T|',
    'main.asm|14||0|4|32775|K|; WPMEMX not a keyword',
    'main.asm|15||0|4|32776|K|; xWPMEM not a keyword either',
    'main.asm|16||0|4|32777|K|// WPMEM counter, 2, w',
    'main.asm|17||0|4|-1|K|; ASSERTION za koncem kódu',
    'main.asm|40||0|4|32800|F|main',      // stejné jméno podruhé: platí první
    'main.asm|41||0|4|32800|T|',
    'Bank.asm|5||0|30|49152|F|bankA',
    'Bank.asm|5||0|30|49152|T|',
    'Bank.asm|6||0|31|49152|F|bankB',
    'Bank.asm|6||0|31|49152|T|',
    'Bank.asm|7||0|31|49155|T|',
    'nopage.asm|1||0|-1|24576|T|',
    'nopage.asm|1||0|-1|24576|F|flat',
    'broken line',
    'main.asm|x||0|4|1|T|',
    '',
].join('\r\n'));
const sld = SldInfo.load(sldPath);
const main = path.join(dir, 'main.asm');
const bank = path.join(dir, 'Bank.asm');

test('řádky → adresy se stránkou; posun na další řádek s kódem (nejvýš o 20)', () => {
    assert.deepEqual(sld.addressesFor(main, 11), { line: 11, addrs: [{ addr: 0x8000, page: 4 }] });
    assert.deepEqual(sld.addressesFor(main, 10), { line: 11, addrs: [{ addr: 0x8000, page: 4 }] }, 'návěští na řádku bez instrukce');
    assert.deepEqual(sld.addressesFor(main, 25), { line: 41, addrs: [{ addr: 0x8020, page: 4 }] });
    assert.equal(sld.addressesFor(main, 14), undefined, 'víc než 20 řádků bez kódu');
    assert.deepEqual(sld.addressesFor(main.toUpperCase(), 13)?.addrs, [{ addr: 0x8005, page: 4 }], 'cesta bez ohledu na velikost písmen');
    assert.equal(sld.addressesFor(path.join(dir, 'jiny.asm'), 1), undefined);
    assert.ok(sld.hasFile(bank.toLowerCase()));
    assert.ok(!sld.hasFile(path.join(dir, 'jiny.asm')));
});

test('vadné řádky SLD se přeskočí', () => {
    assert.ok(!sld.hasFile(path.join(dir, 'broken line')));
    assert.equal(sld.locate(1), undefined);
});

test('locate: adresa → místo; víc stránek na stejné adrese podle namapované stránky', () => {
    assert.deepEqual(sld.locate(0x8003), { file: main, line: 12, page: 4 });
    assert.equal(sld.locate(0x8004), undefined, 'uprostřed instrukce');
    assert.equal(sld.locate(0xc000, () => 31)?.line, 6);
    assert.equal(sld.locate(0xc000, () => 30)?.line, 5);
    assert.equal(sld.locate(0xc000, () => 99)?.file, bank, 'neznámá stránka → první záznam');
    assert.equal(sld.locate(0x16000)?.file, path.join(dir, 'nopage.asm'), 'adresa se ořízne na 16 bitů');
});

test('locatePage: fyzická stránka + posun; bez zařízení (stránka −1) a uprostřed instrukce nic', () => {
    assert.deepEqual(sld.locatePage(4, 3), { file: main, line: 12 });
    assert.deepEqual(sld.locatePage(31, 3), { file: bank, line: 7 });
    assert.deepEqual(sld.locatePage(30, 0x2000), { file: bank, line: 5 }, 'posun se ořízne na 13 bitů');
    assert.equal(sld.locatePage(4, 4), undefined);
    assert.equal(sld.locatePage(0, 0x6000 & 0x1fff), undefined, 'řádek bez stránky fyzickou adresu nemá');
});

test('codeAddresses: každá instrukce jednou se svou stránkou', () => {
    const got = sld.codeAddresses().map((a) => `${a.page}:${a.addr.toString(16)}`).sort();
    assert.deepEqual(got, ['-1:6000', '30:c000', '31:c000', '31:c003', '4:8000', '4:8003', '4:8005', '4:8020'].sort());
});

test('návěští: první výskyt jména platí, nameFor s posunem, symbolMap pro server', () => {
    assert.deepEqual(sld.label('main'), { name: 'main', addr: 0x8000, page: 4 });
    assert.equal(sld.label('main.loop')?.addr, 0x8003);
    assert.equal(sld.labels.filter((l) => l.name === 'main').length, 1);
    assert.equal(sld.nameFor(0x8000), 'main');
    assert.equal(sld.nameFor(0x8004), 'main.loop+1');
    assert.equal(sld.nameFor(0x5fff), undefined, 'před prvním návěštím');
    assert.equal(sld.nameFor(0x6000 + 0x401), undefined, 'víc než 1 KiB za návěštím');
    const map = sld.symbolMap().split('\n');
    assert.ok(map.includes('main = $8000') && map.includes('bankB = $C000') && map.includes('flat = $6000'), map.join(' | '));
    assert.equal(map.at(-1), '');
});

test('klíčová slova: jen celé slovo, i v komentáři //, bez záznamů mimo kód', () => {
    assert.deepEqual(sld.keywords.map((k) => [k.kind, k.line, k.addr, k.page, k.args]), [
        ['LOGPOINT', 12, 0x8003, 4, '[GRP] A=${A:hex}'],
        ['ASSERTION', 13, 0x8005, 4, 'A < 5'],
        ['WPMEM', 16, 0x8009, 4, 'counter, 2, w'],
    ]);
    assert.equal(sld.keywords[0].file, main);
});

test('parseWpmem: prázdné části, podmínka s čárkami a závorkami, stínový registr', () => {
    assert.deepEqual(parseWpmem(''), {});
    assert.deepEqual(parseWpmem(', 1, w'), { size: '1', access: 'w' });
    assert.deepEqual(parseWpmem('rtarget, 1, r, A == 7 && !(B == 1)'), { addr: 'rtarget', size: '1', access: 'r', condition: 'A == 7 && !(B == 1)' });
    assert.deepEqual(parseWpmem('b@(x, 1), 2'), { addr: 'b@(x, 1)', size: '2' });
    assert.deepEqual(parseWpmem("buf, 4, rw, AF' == 5, B == 1"), { addr: 'buf', size: '4', access: 'rw', condition: "AF' == 5, B == 1" });
    assert.deepEqual(parseWpmem("buf, 1, w, A == ','"), { addr: 'buf', size: '1', access: 'w', condition: "A == ','" });
});

test('parseLogpoint: skupina v hranatých závorkách', () => {
    assert.deepEqual(parseLogpoint('[LOOP] A=${A}'), { group: 'LOOP', text: 'A=${A}' });
    assert.deepEqual(parseLogpoint('[ ] text'), { group: undefined, text: 'text' });
    assert.deepEqual(parseLogpoint('text [x]'), { text: 'text [x]' });
});

test('sourceRoot: relativní cesty ze SLD vůči zadané složce', () => {
    const other = SldInfo.load(sldPath, path.join(dir, 'src'));
    assert.ok(other.hasFile(path.join(dir, 'src', 'main.asm')));
    assert.ok(!other.hasFile(main));
});

test('skutečné SLD ze sjasmplus (test/fixtures/keywords.sld)', () => {
    const fx = path.join(__dirname, '..', 'test', 'fixtures');
    const k = SldInfo.load(path.join(fx, 'keywords.sld'));
    const asm = path.join(fx, 'keywords.asm');
    const src = fs.readFileSync(asm, 'utf8').split(/\r?\n/);
    const lineOf = (s: string) => src.findIndex((l) => l.includes(s)) + 1;
    assert.deepEqual(k.keywords.map((x) => x.kind), ['LOGPOINT', 'ASSERTION', 'LOGPOINT', 'ASSERTION', 'WPMEM', 'WPMEM', 'WPMEM']);
    assert.equal(k.keywords[0].line, lineOf('LOGPOINT [LOOP]'));
    assert.equal(k.label('loop')?.addr, 0x800a);
    assert.equal(k.addressesFor(asm, lineOf('BREAK '))?.addrs[0].addr, k.label('brk_fd')?.addr);
    assert.equal(k.locatePage(4, k.label('loop')!.addr & 0x1fff)?.line, lineOf('LOGPOINT [LOOP]'));
    // db na řádku nedává záznam T (BREAK DD 01 přes db se ze SLD nenajde, server ho hlídá sám)
    assert.equal(k.addressesFor(asm, lineOf('db $DD, $01'))?.line, lineOf('ld c, a'));
});
