// Pohledy panelu Next: Sprity, Pattern RAM, Palety (media/views/sprites.js, patterns.js, palettes.js)
// nad podvrženým DOM a umělými daty – dekódování atributů a vzorů, barvy z palet, zvýraznění,
// texty v en/cs/de bez nepřeložených klíčů.
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { b64, byClass, byTag, checkTexts, dictionary, domStrings, FakeElement, findAll, loadViews, makeApi, px, rgb333, TEST_LANGS, translator } from './fakedom';

const AREAS = ['sprites', 'patterns', 'palettes'];

// ---- umělá data
function spriteFields(): any[] {
    const F = (o: any) => Object.assign({ x: 0, y: 0, pattern: 0, paletteOffset: 0, visible: false, xMirror: false, yMirror: false,
        rotate: false, is4bit: false, xScale: 0, yScale: 0, relative: false, anchor: -1 }, o);
    const list = Array.from({ length: 128 }, () => F({}));
    list[0] = F({ x: 100, y: 50, visible: true });
    list[1] = F({ x: 300, y: 60, pattern: 3, paletteOffset: 2, visible: true, is4bit: true, xScale: 1 });
    list[2] = F({ x: 316, y: 52, pattern: 3, paletteOffset: 3, visible: true, is4bit: true, relative: true, anchor: 1 });
    list[3] = F({ x: 10, y: 10, rotate: true, visible: true });
    return list;
}

function machine() {
    const ram = new Uint8Array(16384);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) ram[y * 16 + x] = y * 16 + x;   // 8bit vzor 0
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
        ram[256 + y * 8 + x] = ((2 * x) << 4) | (2 * x + 1);   // 4bit vzor 2: nibble = x
        ram[384 + y * 8 + x] = (y << 4) | y;                    // 4bit vzor 3: nibble = y
    }
    const bank = (mul: number, add: number) => Array.from({ length: 256 }, (_, i) => (i * mul + add) & 511);
    const banks: Record<string, number[]> = {
        ula0: bank(2, 0), ula1: bank(2, 1), layer2_0: bank(2, 0), layer2_1: bank(3, 0),
        sprite0: bank(1, 0), sprite1: bank(2, 1), tilemap0: bank(2, 0), tilemap1: bank(5, 0),
    };
    banks.layer2_0[5] = 0xe3 << 1;   // barva = NR $14 → průhledná
    const nr = new Uint8Array(256);
    nr[0x15] = 0x03; nr[0x4b] = 0xe3; nr[0x43] = 0x08; nr[0x14] = 0xe3; nr[0x42] = 0x07; nr[0x4c] = 0x0f; nr[0x6b] = 0x10;
    const attrs = new Uint8Array(640);
    const setA = (i: number, b: number[]) => b.forEach((v, k) => (attrs[i * 5 + k] = v));
    setA(0, [100, 50, 0x00, 0x80, 0]);                                      // 8bit vzor 0
    setA(1, [44, 60, 0x20 | 0x01, 0x80 | 0x40 | 1, 0x80 | 0x40 | (1 << 3)]); // x=300, 4bit vzor 3, pal 2, 2× X
    setA(2, [16, 0xf8, 0x30, 0x80 | 0x40 | 0, 0x40 | 0x01]);                 // relativní +16, -8, +vzor kotvy, pal 3
    setA(3, [10, 10, 0x02, 0x80, 0]);                                       // rotace, vzor 0
    setA(4, [0, 0, 0, 0x00, 0]);                                            // neviditelný
    const server = (cmd: string) => {
        switch (cmd) {
            case 'sprites': return { sprites: spriteFields(), attrs: b64(attrs), clip: { x1: 0, x2: 255, y1: 0, y2: 191 } };
            case 'patternRam': return { data: b64(ram) };
            case 'palettes': return { banks, activeUla: 0 };
            case 'nextregs': return { data: b64(nr) };
        }
        throw new Error('neznámý příkaz ' + cmd);
    };
    return { ram, banks, nr, attrs, server };
}

for (const lang of TEST_LANGS) {
    describe(`pohledy Sprity / Pattern RAM / Palety [${lang}]`, () => {
        const texts = dictionary(lang, AREAS);
        const T = translator(texts);
        const m = machine();
        const api = makeApi(lang, texts, m.server);
        const { defs } = loadViews(['palettes.js', 'patterns.js', 'sprites.js'], lang, texts);
        const sb = m.banks.sprite1;   // NR $43 b3 = 1 → druhá paleta spritů
        const seen: string[] = [];
        const sEl = new FakeElement('div');
        const pEl = new FakeElement('div');
        const lEl = new FakeElement('div');
        let trs: FakeElement[] = [];

        test('registrace a pořadí záložek', () => {
            assert.deepEqual(Object.keys(defs).sort(), ['palettes', 'patterns', 'sprites']);
            assert.equal(defs.sprites.order, 10);
            assert.equal(defs.patterns.order, 20);
            assert.equal(defs.palettes.order, 30);
            for (const d of Object.values(defs)) checkTexts([d.title], lang, AREAS, 'title');
        });

        test('sprity: tabulka 128 řádků, relativní sprite, filtr neviditelných', async () => {
            defs.sprites.mount(sEl, api);
            await defs.sprites.refresh(api);
            trs = findAll(sEl, (e) => e.tagName === 'TR' && e.parentNode?.tagName === 'TBODY');
            assert.equal(trs.length, 128);
            const cells = (tr: FakeElement) => tr.children.map((c) => c.textContent).slice(0, 10);
            assert.deepEqual(cells(trs[0]), ['0', '', '100', '50', '0', '0', T('sprites.yes'), '–', '–', '1×1']);
            assert.deepEqual(cells(trs[1]), ['1', '', '300', '60', '3', '2', T('sprites.yes'), '–', T('sprites.yes'), '2×1']);
            // relativní: pozice, vzor a 4bit z kotvy (rozvedené serverem), paleta 3
            assert.deepEqual(cells(trs[2]), ['2', T('sprites.relAnchor', 1), '316', '52', '3', '3', T('sprites.yes'), '–', T('sprites.yes'), '1×1']);
            assert.equal(trs[4].style.display, 'none', 'neviditelný sprite skrytý filtrem');
            assert.equal(trs[0].style.display ?? '', '');
        });

        test('sprity: náhledy 8bit/4bit, průhlednost NR $4B, rotace', () => {
            const thumb = (tr: FakeElement) => (tr.children[10] as FakeElement).children[0] as FakeElement;
            assert.deepEqual(px(thumb(trs[0]).image, 5, 2), [...rgb333(sb[0x25]), 255]);
            assert.deepEqual(px(thumb(trs[0]).image, 3, 14), [0, 0, 0, 0], 'index $E3 = NR $4B → průhledný');
            // 4bit vzor 3 (nibble = y), paleta 2 → index $2y; nibble 3 = průhledný ($E3 & 15)
            assert.deepEqual(px(thumb(trs[1]).image, 7, 9), [...rgb333(sb[0x29]), 255]);
            assert.deepEqual(px(thumb(trs[1]).image, 7, 3), [0, 0, 0, 0]);
            assert.deepEqual(px(thumb(trs[2]).image, 0, 5), [...rgb333(sb[0x35]), 255]);
            // rotace: výstup (sloupec, řádek) = vzor (x = řádek, y = 15 − sloupec)
            assert.deepEqual(px(thumb(trs[3]).image, 2, 7), [...rgb333(sb[(15 - 2) * 16 + 7]), 255]);
        });

        test('sprity: zvýraznění při najetí, výběr kliknutím, souhrn, bez překreslení beze změny', async () => {
            trs[1].fire('mouseenter');
            assert.deepEqual(api.highlights.at(-1), { x: 300, y: 60, w: 32, h: 16 });
            trs[1].fire('mouseleave');
            assert.equal(api.highlights.at(-1), null);
            trs[0].fire('click');
            assert.deepEqual(api.highlights.at(-1), { x: 100, y: 50, w: 16, h: 16 });
            assert.ok(trs[0].classList.contains('selected'));
            const sum = findAll(sEl, byClass('sp-sum'))[0].textContent;
            assert.ok(sum.includes(T('sprites.visibleCount', 4, 128)), sum);
            assert.ok(sum.includes(T('sprites.clip', '$00', '$FF', '$00', '$BF', 0, 319, 0, 255)), sum);
            const canvas = (trs[0].children[10] as FakeElement).children[0] as FakeElement;
            const before = canvas.puts;
            await defs.sprites.refresh(api);
            assert.equal(canvas.puts, before, 'stejná data → náhled se nekreslí znovu');
            seen.push(...domStrings(sEl));
        });

        test('pattern RAM: mřížka 64/128 vzorů, posun palety, detail a pixel pod myší', () => {
            return (async () => {
                defs.patterns.mount(pEl, api);
                await defs.patterns.refresh(api);
                let cells = findAll(pEl, byClass('pt-cell'));
                assert.equal(cells.length, 64);
                assert.deepEqual(px((cells[0].children[0] as FakeElement).image, 5, 2), [...rgb333(sb[0x25]), 255]);
                assert.ok(cells[0].classList.contains('used'), 'vzor 0 používá viditelný sprite');
                const [mode, pal, off] = findAll(pEl, byTag('select'));
                mode.value = '4';
                mode.fire('change');
                cells = findAll(pEl, byClass('pt-cell'));
                assert.equal(cells.length, 128);
                off.value = '5';
                off.fire('change');
                let im = (cells[3].children[0] as FakeElement).image;
                assert.deepEqual(px(im, 0, 9), [...rgb333(sb[0x59]), 255]);
                assert.deepEqual(px(im, 0, 3), [0, 0, 0, 0]);
                pal.value = '0';
                pal.fire('change');
                im = (cells[3].children[0] as FakeElement).image;
                assert.deepEqual(px(im, 0, 9), [...rgb333(m.banks.sprite0[0x59]), 255]);
                cells[3].fire('click');
                const det = findAll(pEl, byClass('pt-detail'))[0];
                assert.ok(det.textContent.includes(T('patterns.visibleSprites', '1, 2')), det.textContent);
                const big = det.children[1] as FakeElement;
                big.fire('mousemove', { clientX: 4 * 16 + 3, clientY: 9 * 16 + 3 });
                assert.equal(det.children[2].textContent,
                    T('patterns.pixelHigh', 4, 9, '$01CA', '$9') + ' → ' + T('patterns.pixelColor', '$59', '$059', 1, 3, 1, '#246d24'));
                seen.push(...domStrings(pEl));
                // 4bit → 8bit: vybraný vzor 3 → 1
                mode.value = '8';
                mode.fire('change');
                assert.ok(det.textContent.includes(T('patterns.detailHead', 1, '8bit', '$0100', '$01FF', 1, 5)), det.textContent);
                cells = findAll(pEl, byClass('pt-cell'));
                cells[1].fire('click');
                big.fire('mousemove', { clientX: 5 * 16 + 3, clientY: 0 });
                seen.push(...domStrings(pEl));
                big.fire('mouseleave');
                seen.push(...domStrings(pEl));
            })();
        });

        test('palety: 8 bank, aktivní a zapisovaná banka, průhledná barva, popis pod myší, ULANext', async () => {
            defs.palettes.mount(lEl, api);
            await defs.palettes.refresh(api);
            const boxes = findAll(lEl, byClass('pl-bank'));
            assert.equal(boxes.length, 8);
            assert.deepEqual(boxes.map((b) => b.classList.contains('active')), [true, false, true, false, false, true, false, true]);
            // cíl zápisu NR $43 b6:4 = 0 → ULA 1.
            const mark = (i: number) => ((boxes[i].children[0] as FakeElement).children[2] as FakeElement).style.display ?? '';
            assert.equal(mark(0), '');
            assert.equal(mark(1), 'none');
            const cnv = (i: number) => boxes[i].children[1] as FakeElement;
            // položka 5 v Layer 2 1. má barvu NR $14 → křížek (střed buňky kontrastní)
            const im = cnv(2).image;
            const transparent = rgb333(0xe3 << 1);
            assert.notDeepEqual(px(im, 5 * 14 + 1 + 6, 1 + 6).slice(0, 3), transparent);
            assert.deepEqual(px(im, 5 * 14 + 2, 1), [...transparent, 255]);
            assert.equal(px(im, 0, 0)[3], 0, 'mřížka průhledná');
            cnv(4).fire('mousemove', { clientX: 3 * 14 + 2, clientY: 1 * 14 + 2 });
            const info = () => findAll(lEl, byClass('pl-info'))[0].textContent;
            assert.ok(info().includes(T('palettes.info', T('palettes.bankName', T('palettes.sprites'), 1), '$13', 19, '$013', 0, 2, 3, '$09', '#00496d')), info());
            const legend = () => findAll(lEl, byClass('pl-legend'))[0].textContent;
            assert.ok(legend().startsWith(T('palettes.legendStd')), legend());
            seen.push(...domStrings(lEl));
            m.nr[0x43] = 0x09;
            m.nr[0x42] = 0x0f;
            await defs.palettes.refresh(api);
            assert.ok(legend().includes(T('palettes.legendUlaNext', '$0F', 15, 143)), legend());
            cnv(0).fire('mousemove', { clientX: 2 * 14 + 2, clientY: 8 * 14 + 2 });
            assert.ok(info().includes(T('palettes.rolePaperBorder')), info());
            cnv(0).fire('mousemove', { clientX: 2 * 14 + 2, clientY: 9 * 14 + 2 });
            assert.ok(info().includes(T('palettes.unused')), info());
            seen.push(...domStrings(lEl));
            for (const [c, x, y] of [[2, 5, 0], [6, 15, 0], [4, 3, 14]]) {
                cnv(c).fire('mousemove', { clientX: x * 14 + 2, clientY: y * 14 + 2 });
                seen.push(...domStrings(lEl));
            }
            cnv(0).fire('mouseleave');
            m.nr[0x42] = 0x05;
            await defs.palettes.refresh(api);
            seen.push(...domStrings(lEl));
            m.nr[0x43] = 0x00;
            m.nr[0x42] = 0x07;
            await defs.palettes.refresh(api);
            cnv(0).fire('mousemove', { clientX: 2, clientY: 1 * 14 + 2 });
            seen.push(...domStrings(lEl));
            cnv(0).fire('mousemove', { clientX: 2, clientY: 2 * 14 + 2 });
            seen.push(...domStrings(lEl));
        });

        test('chyby serveru a chybějící NEXTREG', async () => {
            m.nr[0x15] = 0x40;
            await defs.sprites.refresh(api);
            seen.push(...domStrings(sEl));
            const ok = api.request;
            const failing = (cmds: string[]) => (api.request = async (cmd: string, args?: any) => {
                if (cmds.includes(cmd)) throw new Error('boom');
                return ok(cmd, args);
            });
            try {
                failing(['nextregs', 'sprites']);
                await defs.palettes.refresh(api);
                assert.ok(findAll(lEl, (e) => e.classList.contains('mono') && e.tagName === 'SPAN')[0].textContent.endsWith(T('palettes.noNextreg')));
                await defs.patterns.refresh(api);
                seen.push(...domStrings(lEl), ...domStrings(pEl));
                failing(['sprites', 'patternRam', 'palettes', 'nextregs']);
                await defs.sprites.refresh(api);
                await defs.patterns.refresh(api);
                await defs.palettes.refresh(api);
            } finally {
                api.request = ok;
            }
            const after = [...domStrings(sEl), ...domStrings(pEl), ...domStrings(lEl)];
            for (const k of ['sprites.error', 'patterns.error', 'palettes.error']) assert.ok(after.includes(T(k, 'boom')), k);
            seen.push(...after);
        });

        test('texty v DOM přeložené (žádný klíč, parametr ani čeština v jiném jazyce)', () => {
            assert.ok(seen.length > 300, 'posbíráno textů: ' + seen.length);
            checkTexts(seen, lang, AREAS, 'Sprity/Vzory/Palety');
        });
    });
}
