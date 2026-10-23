// Pohledy panelu Next: NEXTREG a Copper (media/views/nextreg-names.js, nextreg.js, copper.js) –
// tabulka jmen a polí registrů, rozpis hodnot, zvýraznění změn, filtry, dekódování programu
// Copperu (WAIT/MOVE/NOP/HALT), převod řádků na obraz, texty v en/cs/de bez nepřeložených klíčů.
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { b64, byTag, checkTexts, dictionary, domStrings, FakeElement, findAll, loadViews, makeApi, TEST_LANGS, translator } from './fakedom';

const AREAS = ['copper', 'nextreg'];

for (const lang of TEST_LANGS) {
    describe(`pohledy NEXTREG / Copper [${lang}]`, () => {
        const texts = dictionary(lang, AREAS);
        const T = translator(texts);
        const responses: Record<string, any> = {};
        const api = makeApi(lang, texts, (cmd) => {
            if (!(cmd in responses)) throw new Error('no ' + cmd);
            return responses[cmd];
        });
        // pořadí jako ve webview: abecedně
        const { defs, window } = loadViews(['copper.js', 'nextreg-names.js', 'nextreg.js'], lang, texts);
        const N = window.NextRegNames;
        const dec = (n: number, v: number) => Object.fromEntries(N.decode(n, v).map((p: any) => [p.label, p.text]));
        const isRow = (e: FakeElement) => e.tagName === 'TR' && e.parentNode?.tagName === 'TBODY';
        const regs = new Uint8Array(256);
        const nrRoot = new FakeElement('div');
        const cuRoot = new FakeElement('div');
        let trs: FakeElement[] = [];
        let crow: FakeElement[] = [];
        const prog = new Uint16Array(1024);

        test('registrace pohledů', () => {
            assert.equal(defs.copper.order, 70);
            assert.equal(defs.nextreg.order, 80);
            assert.equal(defs.nextreg.title, 'NEXTREG');
        });

        test('tabulka registrů: jména z JNEXT a opravy, skupiny, přístup', () => {
            assert.equal(N.name(0x15), 'Spr/Layer Prior');
            assert.ok(N.get(0x15).fromJnext);
            assert.equal(N.name(0x1e), 'Active Line MSB');
            assert.ok(!N.get(0x1e).fromJnext);
            assert.equal(N.name(0x10), 'Core Boot');
            assert.equal(N.name(0x0e), 'Core Version Sub');
            assert.equal(N.name(0x0d), null);
            for (const n of N.list) {
                const r = N.get(n);
                assert.ok(N.groups.includes(r.group), 'skupina $' + n.toString(16) + ' ' + r.group);
                assert.ok(['r', 'w', 'rw'].includes(r.access));
            }
        });

        test('pole registrů se nepřekrývají a leží v bitech 0–7', () => {
            for (const n of N.list) {
                let used = 0;
                for (const f of N.get(n).fields) {
                    assert.ok(f.hi >= f.lo && f.hi <= 7 && f.lo >= 0, '$' + n.toString(16));
                    const mask = ((1 << (f.hi - f.lo + 1)) - 1) << f.lo;
                    assert.equal(used & mask, 0, 'překryv v $' + n.toString(16));
                    used |= mask;
                }
            }
        });

        test('rozpis hodnot: $15, joysticky $05, $07, $43, $62, $6B, $6E, $70, MMU, $03, $14', () => {
            const d = dec(0x15, 0x51);
            assert.equal(d[T('nextreg.r15.f.order')], 'USL');
            assert.equal(d[T('nextreg.r15.f.sprite0OnTop')], T('nextreg.v.yes'));
            assert.equal(d['LoRes'], T('nextreg.v.no'));
            assert.equal(d[T('nextreg.r15.f.visible')], T('nextreg.v.yes'));
            // joy1 = %101 (MD 1): bit 3 = 1, 7:6 = 01; joy2 = %100 (Kempston 2): bit 1 = 1, 5:4 = 00; 60 Hz
            const j = dec(0x05, 0b01001110);
            assert.equal(j[T('nextreg.r05.f.joy1')], 'MD 1');
            assert.equal(j[T('nextreg.r05.f.joy2')], 'Kempston 2');
            assert.equal(j[T('nextreg.r05.f.refresh')], '60 Hz');
            const k = dec(0x05, 0x41);
            assert.equal(k[T('nextreg.r05.f.joy1')], 'Kempston 1');
            assert.equal(k[T('nextreg.r05.f.joy2')], 'Sinclair 2');
            assert.equal(k['scandoubler'], T('nextreg.v.yes'));
            assert.deepEqual([dec(0x07, 0x32)[T('nextreg.r07.f.actual')], dec(0x07, 0x32)[T('nextreg.r07.f.requested')]], ['28 MHz', '14 MHz']);
            assert.equal(dec(0x43, 0x50)[T('nextreg.r43.f.edited')], 'Layer 2 2');
            assert.equal(dec(0x62, 0xc1)[T('nextreg.r62.f.mode')], T('nextreg.r62.v.frameReset'));
            assert.equal(dec(0x62, 0xc1)[T('nextreg.r62.f.addrBits')], '1');
            assert.equal(dec(0x6b, 0xc0)[T('nextreg.r6B.f.columns')], '80×32');
            assert.equal(dec(0x6e, 0x80 | 0x2c)[T('nextreg.r6E.f.addrMsb')], T('nextreg.r6E.v.address', 7, '$2C00'));
            assert.equal(dec(0x70, 0x1a)[T('nextreg.r70.f.resolution')], '320×256 8bpp');
            assert.equal(dec(0x70, 0x1a)[T('nextreg.f.paletteOffset')], '10');
            assert.equal(dec(0x50, 0xff)[T('nextreg.r50.f.page')], 'ROM');
            assert.equal(dec(0x52, 0xff)[T('nextreg.r50.f.page')], '255');
            assert.equal(dec(0x03, 0xb3)[T('nextreg.r03.f.timing')], '+3');
            assert.equal(dec(0x03, 0xb3)[T('nextreg.r03.f.machineType')], '+3');
            assert.equal(dec(0x14, 0xe3)['RRRGGGBB'], 'R7 G0 B3');
        });

        test('NEXTREG: 256 řádků, nedefinované skryté, hodnoty v hex/dec/bin a rozpis', async () => {
            defs.nextreg.mount(nrRoot, api);
            regs[0x15] = 0x51; regs[0x07] = 0x32; regs[0x64] = 0; regs[0x03] = 0x30; regs[0x05] = 0x41;
            responses.nextregs = { data: b64(regs) };
            await defs.nextreg.refresh(api);
            trs = findAll(nrRoot, isRow);
            assert.equal(trs.length, 256);
            assert.ok(trs[0x0d].hidden);
            assert.ok(!trs[0x15].hidden);
            const t = trs[0x15].children.map((c) => c.textContent);
            assert.equal(t[0], '$15');
            assert.equal(t[4], '$51');
            assert.equal(t[5], '81');
            assert.equal(t[6], '0101 0001');
            assert.ok(t[7].includes(T('nextreg.r15.f.order') + ': USL'), t[7]);
            assert.ok(!trs[0x15].classList.contains('changed'));
        });

        test('NEXTREG: změněný registr a bit zvýrazněné, při dalším obnovení zvýraznění zmizí', async () => {
            regs[0x15] = 0x53;
            responses.nextregs = { data: b64(regs) };
            await defs.nextreg.refresh(api);
            assert.ok(trs[0x15].classList.contains('changed'));
            assert.ok(!trs[0x07].classList.contains('changed'));
            const bits = findAll(trs[0x15], (e) => e.className.includes('nr-bit'));
            assert.ok(bits[6].className.includes('diff'), 'bit 1 = 7. buňka');
            assert.ok(!bits[7].className.includes('diff'));
            assert.ok(findAll(trs[0x15], byTag('b')).map((e) => e.textContent).includes(T('nextreg.v.yes')));
            await defs.nextreg.refresh(api);
            assert.ok(!trs[0x15].classList.contains('changed'));
        });

        test('NEXTREG: filtr textem a skupinou', () => {
            const input = findAll(nrRoot, (e) => e.tagName === 'INPUT' && e.type === 'text')[0];
            const shown = () => trs.map((t, i) => (t.hidden ? -1 : i)).filter((i) => i >= 0);
            input.value = 'mmu slot';
            input.fire('input');
            assert.equal(shown().length, 8);
            input.value = '$6b';
            input.fire('input');
            assert.deepEqual(shown(), [0x6b]);
            input.value = '';
            input.fire('input');
            const sel = findAll(nrRoot, byTag('select'))[0];
            sel.value = T('nextreg.group.copper');
            sel.fire('change');
            assert.deepEqual(shown(), [0x60, 0x61, 0x62, 0x63, 0x64]);
        });

        test('Copper: dekódování WAIT/MOVE/NOP/HALT a řádky obrazu', async () => {
            prog[0] = 0x8000 | (10 << 9) | 0;   // WAIT řádek 0, h 10
            prog[1] = (0x15 << 8) | 0x51;       // MOVE NR $15 ← $51
            prog[2] = 0x8000 | 100;             // WAIT řádek 100
            prog[3] = 0x0000;                   // NOP
            prog[4] = 0x8000 | 230;             // WAIT řádek 230 (pod obrazem)
            prog[5] = 0x8000 | 400;             // WAIT řádek 400 (nikdy)
            prog[6] = 0x0042;                   // NOP (MOVE do NR 0)
            prog[7] = 0xffff;                   // HALT
            prog[8] = (0x40 << 8) | 0x10;       // MOVE za HALT
            prog[9] = 0x8000 | (63 << 9) | 290; // WAIT řádek 290 (horní okraj), h 63
            responses.copper = { pc: 2, running: true, mode: 3, program: b64(new Uint8Array(prog.buffer)) };
            regs[0x64] = 0; regs[0x03] = 0x30; regs[0x05] = 0x41;
            responses.nextregs = { data: b64(regs) };
            defs.copper.mount(cuRoot, api);
            await defs.copper.refresh(api);
            crow = findAll(cuRoot, isRow);
            const txt = (i: number) => crow[i].children.map((c) => c.textContent);
            assert.deepEqual(txt(0), ['000', '$9400', 'WAIT', T('copper.waitArgs', 0, 10), 'y 32']);
            assert.deepEqual(txt(1), ['001', '$1551', 'MOVE', 'NR $15 Spr/Layer Prior ← $51', '']);
            assert.ok((crow[1].children[3] as FakeElement).title.includes(T('nextreg.r15.f.order') + ': USL'));
            assert.deepEqual(txt(2).slice(2), ['WAIT', T('copper.waitArgs', 100, 0), 'y 132']);
            assert.deepEqual(txt(3).slice(1, 3), ['$0000', 'NOP']);
            assert.deepEqual(txt(4).slice(2), ['WAIT', T('copper.waitArgs', 230, 0), T('copper.offscreen')]);
            assert.deepEqual(txt(5).slice(4), [T('copper.never', 311)]);
            assert.ok((crow[5].children[3] as FakeElement).title.includes('HALT'));
            assert.deepEqual(txt(6).slice(2, 4), ['NOP', T('copper.nopMove')]);
            assert.deepEqual(txt(7).slice(1, 3), ['$FFFF', 'HALT']);
            // 311 řádků, zobrazení od 64: řádky 247..310 jsou před zobrazením → 290 − 311 + 32 = 11
            assert.deepEqual(txt(9).slice(4), ['y 11']);
            assert.ok((crow[9].children[3] as FakeElement).title.includes('hc ≥ 4'));
        });

        test('Copper: PC, stav, zvýraznění řádku obrazu při najetí, volby zobrazení', () => {
            assert.ok(crow[2].classList.contains('pc'));
            assert.ok(!crow[0].classList.contains('pc'));
            const st = findAll(cuRoot, (e) => e.className === 'cu-state')[0].textContent;
            assert.ok(st.includes('$002') && st.includes(T('copper.state.running')) && st.includes(T('copper.mode.frameReset')) && st.includes(T('copper.state.lines', 311)), st);
            const tbody = crow[0].parentNode!;
            api.highlights.length = 0;
            tbody.fire('mouseover', { target: crow[2].children[1] });
            tbody.fire('mouseover', { target: crow[2].children[2] });   // stejný řádek → neposílá znovu
            tbody.fire('mouseover', { target: crow[1].children[0] });   // MOVE → null
            tbody.fire('mouseover', { target: crow[4].children[0] });   // mimo obraz → null (už je)
            tbody.fire('mouseleave', {});
            assert.deepEqual(api.highlights, [{ x: 0, y: 132, w: 320, h: 1 }, null]);
            const sel = findAll(cuRoot, byTag('select'))[0];
            sel.value = 'halt';
            sel.fire('change');
            assert.ok(!crow[7].hidden && crow[8].hidden && crow[500].hidden);
            sel.value = 'trim';
            sel.fire('change');
            assert.ok(!crow[9].hidden && crow[10].hidden);
            sel.value = 'all';
            sel.fire('change');
            assert.ok(!crow[1023].hidden);
        });

        test('Copper: posun NR $64, 60 Hz, změna PC a slova, bez NEXTREG odhad geometrie', async () => {
            regs[0x64] = 10;
            regs[0x05] = 0x45;
            responses.nextregs = { data: b64(regs) };
            prog[3] = (0x4a << 8) | 0xe3;
            responses.copper = { pc: 700, running: true, mode: 1, program: b64(new Uint8Array(prog.buffer)) };
            await defs.copper.refresh(api);
            const txt = (i: number) => crow[i].children.map((c) => c.textContent);
            // 264 řádků, zobrazení od 40: (0 − 10) mod 264 = 254 ≥ 224 → −10 → y 22
            assert.deepEqual(txt(0).slice(4), ['y 22']);
            assert.deepEqual(txt(2).slice(4), ['y 122']);
            assert.deepEqual(txt(5).slice(4), [T('copper.never', 264)]);
            assert.deepEqual(txt(3).slice(2, 4), ['MOVE', 'NR $4A Fallback Colour ← $E3']);
            assert.ok(crow[700].classList.contains('pc') && !crow[2].classList.contains('pc'));
            const sel = findAll(cuRoot, byTag('select'))[0];
            sel.value = 'halt';
            sel.fire('change');
            assert.ok(!crow[700].hidden, 'PC je vidět vždy');
            assert.ok(crow[699].hidden);
            delete responses.nextregs;
            await defs.copper.refresh(api);
            const st = findAll(cuRoot, (e) => e.className === 'cu-state')[0].textContent;
            assert.ok(st.includes(T('copper.state.geometryGuess')), st);
        });

        test('texty v DOM a rozpis všech registrů přeložené', () => {
            const all = [...domStrings(nrRoot), ...domStrings(cuRoot)];
            for (const n of N.list) {
                const r = N.get(n);
                all.push(r.desc, r.group, r.rw);
                for (const v of [0, 0x55, 0xaa, 0xff]) for (const p of N.decode(n, v)) all.push(p.label, p.text);
            }
            for (const e of crow) all.push((e.children[3] as FakeElement).title);
            assert.ok(all.length > 3000, 'textů: ' + all.length);
            checkTexts(all.filter((s) => typeof s === 'string'), lang, AREAS, 'NEXTREG/Copper');
        });
    });
}
