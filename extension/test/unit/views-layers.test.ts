// Pohledy panelu Next: Layer 2, Tilemapa, Vrstvy (media/views/layer2.js, tilemap.js, layers.js) –
// dekódovací funkce na umělých datech (barvy, režimy, zrcadlení a rotace dlaždic, posuny, ořezy)
// a kouřový test mount/refresh/hover nad podvrženým DOM v en/cs/de bez nepřeložených klíčů.
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { b64, byTag, checkTexts, dictionary, domStrings, FakeElement, findAll, loadViews, makeApi, TEST_LANGS, tick, translator } from './fakedom';

const AREAS = ['layers', 'layer2', 'tilemap'];
const eq = (a: any, b: any, m?: string) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

const C3 = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => (c << 5) | (c << 2) | (c >> 1));
/** RGB333 → u32 RGBA (little endian, jak ho pohledy zapisují do ImageData) */
const rgba = (c9: number) => ((255 << 24) | (C3[c9 & 7] << 16) | (C3[(c9 >> 3) & 7] << 8) | C3[(c9 >> 6) & 7]) >>> 0;
function rand(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
}
const palBank = (f: (i: number) => number) => Array.from({ length: 256 }, (_, i) => f(i) & 0x1ff);
const hasClass = (c: string) => (e: FakeElement) => !!e.className && e.className.includes(c);

/** Falešný server: SRAM po 8K stránkách; `long` = čtení přes víc stránek (nový server), jinak jen jedna stránka. */
function makeServer(o: { nr: Uint8Array; banks?: any; pages?: Record<number, Uint8Array>; long?: boolean; clips?: any }) {
    const pages = o.pages || {};
    const page = (p: number) => pages[p] || (pages[p] = new Uint8Array(0x2000));
    return (cmd: string, a: any) => {
        switch (cmd) {
            case 'nextregs': return { data: b64(o.nr), ...(o.clips ? { clips: o.clips } : {}) };
            case 'palettes': return { banks: o.banks, activeUla: 0 };
            case 'sprites': return { sprites: [], attrs: '', clip: { x1: 0, x2: 255, y1: 0, y2: 191 } };
            case 'readMemory': {
                const len = a.length | 0;
                if (!o.long && a.addr + len > 0x2000) throw new Error('RefusedUnavailable');
                if (len > 0x30000) throw new Error('too long');
                const out = new Uint8Array(len);
                for (let i = 0; i < len; i++) out[i] = page(a.page + ((a.addr + i) >> 13))[(a.addr + i) & 0x1fff];
                return { data: b64(out) };
            }
            case 'renderLayer': {
                const d = new Uint8Array(640 * 256 * 4);
                const tag = ['composite', 'ula', 'ulaShadow', 'layer2', 'layer2Shadow', 'sprites', 'tilemap', 'background'].indexOf(a.layer);
                for (let i = 0; i < 640 * 256; i++) {
                    d[i * 4] = tag * 30;
                    d[i * 4 + 1] = i & 255;
                    d[i * 4 + 2] = 7;
                    d[i * 4 + 3] = i % 3 ? 255 : 0;
                }
                return { width: 640, height: 256, data: b64(d) };
            }
        }
        throw new Error('neznámý příkaz ' + cmd);
    };
}

// Referenční geometrie dlaždice: rotace o 90° po směru hodin, pak zrcadlo X, pak zrcadlo Y
function geom(src: number[], xm: boolean, ym: boolean, rot: boolean): number[] {
    let a = src.slice();
    const at = (b: number[], x: number, y: number) => b[y * 8 + x];
    const map = (f: (x: number, y: number) => number) => {
        const b = new Array(64);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[y * 8 + x] = f(x, y);
        return b;
    };
    if (rot) { const s = a; a = map((x, y) => at(s, y, 7 - x)); }
    if (xm) { const s = a; a = map((x, y) => at(s, 7 - x, y)); }
    if (ym) { const s = a; a = map((x, y) => at(s, x, 7 - y)); }
    return a;
}

const nrTm = (v6b: number, extra: Record<number, number> = {}) => {
    const nr = new Uint8Array(256);
    nr[0x6b] = v6b; nr[0x6e] = 0x2c; nr[0x6f] = 0x0c; nr[0x4c] = 0x0f;
    for (const k in extra) nr[+k] = extra[k];
    return nr;
};

describe('Layer 2: dekódování', () => {
    const texts = dictionary('en', AREAS);
    const L2 = loadViews(['layer2.js'], 'en', texts, ['colourLut', 'decode', 'pixelAddr', 'visibleRects', 'readPages', 'MODES']).x;
    const pal = palBank((i) => i * 7 + 3);

    test('colourLut 8bpp: posun palety k hornímu nibblu, průhlednost RRRGGGBB', () => {
        const { lut, idx } = L2.colourLut(0, pal, 3, pal[0x35] >> 1);
        assert.equal(idx[0x05], 0x35);
        assert.equal(idx[0xe7], 0x17);   // (0xE + 3) & 15 = 1
        assert.equal(lut[0x05], 0, 'průhledný');
        assert.equal(lut[0xe7], rgba(pal[0x17]));
    });

    test('colourLut 4bpp: posun << 4 | nibble', () => {
        const { lut, idx } = L2.colourLut(2, pal, 5, 0x1ff);
        assert.equal(lut.length, 16);
        assert.equal(idx[9], 0x59);
        assert.equal(lut[9], rgba(pal[0x59]));
    });

    test('decode 256×192 po řádcích', () => {
        const mem = new Uint8Array(0xc000);
        for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) mem[y * 256 + x] = (x ^ (y * 3)) & 255;
        const { lut } = L2.colourLut(0, pal, 0, pal[0x42] >> 1);
        const p = L2.decode(mem, 0, lut);
        assert.equal(p.length, 256 * 192);
        for (const [x, y] of [[0, 0], [17, 100], [255, 191], [128, 64]]) {
            const v = (x ^ (y * 3)) & 255;
            assert.equal(p[y * 256 + x], v === 0x42 ? 0 : rgba(pal[v]), x + ',' + y);
        }
        assert.equal(L2.pixelAddr(0, 17, 100), 100 * 256 + 17);
    });

    test('decode 320×256 po sloupcích', () => {
        const mem = new Uint8Array(0x14000);
        for (let x = 0; x < 320; x++) for (let y = 0; y < 256; y++) mem[x * 256 + y] = (x * 5 + y) & 255;
        const { lut } = L2.colourLut(1, pal, 0, 0x1ff);
        const p = L2.decode(mem, 1, lut);
        assert.equal(p.length, 320 * 256);
        for (const [x, y] of [[0, 0], [319, 255], [200, 13], [64, 128]]) assert.equal(p[y * 320 + x], rgba(pal[(x * 5 + y) & 255]));
        assert.equal(L2.pixelAddr(1, 200, 13), 200 * 256 + 13);
    });

    test('decode 640×256 4bpp: vyšší nibble vlevo', () => {
        const mem = new Uint8Array(0x14000);
        mem[10 * 256 + 7] = 0xa3;   // sloupec 10 → pixely 20 (A) a 21 (3), řádek 7
        const { lut } = L2.colourLut(2, pal, 2, pal[0x23] >> 1);
        const p = L2.decode(mem, 2, lut);
        assert.equal(p.length, 640 * 256);
        assert.equal(p[7 * 640 + 20], rgba(pal[0x2a]));
        assert.equal(p[7 * 640 + 21], 0, 'nibble 3 → index $23 průhledný');
        assert.equal(L2.pixelAddr(2, 21, 7), 10 * 256 + 7);
    });

    test('decode s krátkými daty nespadne', () => {
        const { lut } = L2.colourLut(1, pal, 0, 0x1ff);
        assert.equal(L2.decode(new Uint8Array(100), 1, lut)[255 * 320 + 319], 0);
    });

    test('visibleRects: posun se zalomením, ořez', () => {
        let v = L2.visibleRects(0, 10, 5, null);
        eq(v.origin, { x: 10, y: 5 });
        assert.equal(v.rects.length, 4);
        assert.equal(v.rects.reduce((s: number, r: any) => s + r.w * r.h, 0), 256 * 192);
        v = L2.visibleRects(0, 0x100 | 3, 200, null);   // X jen 8 bitů, Y mod 192
        eq(v.origin, { x: 3, y: 8 });
        v = L2.visibleRects(1, 0, 0, { x1: 8, x2: 151, y1: 16, y2: 239 });
        eq(v.rects, [{ x: 16, y: 16, w: 288, h: 224 }]);
        v = L2.visibleRects(2, 300, 0, { x1: 0, x2: 159, y1: 0, y2: 255 });
        eq(v.origin, { x: 600, y: 0 });
        eq(v.rects, [{ x: 600, y: 0, w: 40, h: 256 }, { x: 0, y: 0, w: 600, h: 256 }]);
    });

    test('readPages: server po jedné stránce i přes víc stránek', async () => {
        for (const long of [false, true]) {
            const pages: Record<number, Uint8Array> = {};
            for (let p = 16; p < 26; p++) pages[p] = new Uint8Array(0x2000).fill(p);
            const api = makeApi('en', texts, makeServer({ nr: new Uint8Array(256), long, pages }));
            // nový kontext: pohled si pamatuje, že server čte jen po stránkách
            const { readPages } = loadViews(['layer2.js'], 'en', texts, ['readPages']).x;
            const d = await readPages(api, 16, 0x14000);
            assert.equal(d.length, 0x14000);
            for (let p = 0; p < 10; p++) assert.equal(d[p * 0x2000 + 5], 16 + p, 'stránka ' + p);
            assert.equal(api.log.length, long ? 2 : 12, 'počet dotazů');
        }
    });
});

describe('Tilemapa: dekódování', () => {
    const TM = loadViews(['tilemap.js'], 'en', dictionary('en', AREAS), ['control', 'base', 'vread', 'mapEntry', 'tilePixels', 'colourLut', 'renderMap', 'renderDefs', 'visibleRects']).x;
    const vram = () => ({ b5: new Uint8Array(0x4000), b7: new Uint8Array(0x2000) });

    test('adresy NR $6E/$6F (bit 7 = banka 7, b5:0 × 256)', () => {
        eq(TM.base(0x2c), { bank7: false, off: 0x2c00 });
        eq(TM.base(0x81), { bank7: true, off: 0x100 });
        eq(TM.base(0x7f), { bank7: false, off: 0x3f00 });
        const mem = vram();
        mem.b5[5] = 1;
        mem.b7[5] = 2;
        assert.equal(TM.vread(mem, { bank7: false }, 0x4005), 1, 'banka 5 zalamuje na 16K');
        assert.equal(TM.vread(mem, { bank7: true }, 0x2005), 2, 'banka 7 zalamuje na 8K');
    });

    test('dlaždice 4bpp: všech 8 kombinací zrcadlení a rotace', () => {
        const r = rand(7);
        const mem = vram();
        for (let i = 0; i < 0x4000; i++) mem.b5[i] = r();
        const cfg = TM.control(nrTm(0x80, { 0x4c: 0x10 }));
        cfg.transp = 99;   // bez průhlednosti (test geometrie)
        const db = TM.base(0x0c);
        const tile = 37;
        const src: number[] = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const b = mem.b5[0x0c00 + tile * 32 + y * 4 + (x >> 1)];
            src.push(x & 1 ? b & 15 : b >> 4);
        }
        for (let f = 0; f < 8; f++) {
            const xm = !!(f & 1), ym = !!(f & 2), rot = !!(f & 4);
            const attr = 0x50 | (xm ? 8 : 0) | (ym ? 4 : 0) | (rot ? 2 : 0);
            eq(Array.from(TM.tilePixels(mem, cfg, db, tile, attr)), geom(src, xm, ym, rot).map((n) => 0x50 | n), `xm ${xm} ym ${ym} rot ${rot}`);
        }
    });

    test('průhledný index NR $4C', () => {
        const mem = { b5: new Uint8Array(0x4000).fill(0x5f), b7: new Uint8Array(0x2000) };
        const p = TM.tilePixels(mem, TM.control(nrTm(0x80, { 0x4c: 0x0f })), TM.base(0), 0, 0x30);
        assert.equal(p[0], 0x35);
        assert.equal(p[1], -1);
    });

    test('textový režim 1bpp: bit 7 vlevo, index = paleta·2 | bit, bez zrcadlení; průhlednost podle NR $14', () => {
        const mem = vram();
        mem.b5[0x0c00 + 3 * 8 + 2] = 0x81;   // dlaždice 3, řádek 2
        const cfg = TM.control(nrTm(0x88));
        assert.ok(cfg.text);
        const p = TM.tilePixels(mem, cfg, TM.base(0x0c), 3, 0x0f);   // paleta 7, b3:1 by jinak byly zrcadla
        assert.equal(p[2 * 8 + 0], 0x0f);
        assert.equal(p[2 * 8 + 1], 0x0e);
        assert.equal(p[2 * 8 + 7], 0x0f);
        assert.equal(p[0], 0x0e);
        cfg.nr14 = 0x0e >> 1;
        const lut = TM.colourLut(palBank((i) => i), cfg);
        assert.equal(lut[0x0e], 0);
        assert.equal(lut[0x0f], 0);   // 0x0f >> 1 = 7 = taky shoda
        assert.notEqual(lut[0x10], 0);
    });

    test('mapa: 512 dlaždic s atributy, bez atributů (NR $6C), 80 sloupců', () => {
        const mem = vram();
        let cfg = TM.control(nrTm(0x82));
        const mb = TM.base(0x2c);
        const a = 0x2c00 + (2 * 40 + 3) * 2;
        mem.b5[a] = 0x12;
        mem.b5[a + 1] = 0x31;
        eq(TM.mapEntry(mem, cfg, mb, 3, 2), { addr: a, tile: 0x112, attr: 0x31 });
        cfg = TM.control(nrTm(0xe0, { 0x6c: 0x47 }));
        assert.equal(cfg.cols, 80);
        const a2 = 0x2c00 + (2 * 80 + 3);
        mem.b5[a2] = 0x99;
        eq(TM.mapEntry(mem, cfg, mb, 3, 2), { addr: a2, tile: 0x99, attr: 0x47 });
    });

    test('renderMap a renderDefs: pixel dlaždice na správném místě', () => {
        const mem = vram();
        const cfg = TM.control(nrTm(0x80, { 0x4c: 0 }));
        const mb = TM.base(0x2c), db = TM.base(0x0c);
        const a = 0x2c00 + (5 * 40 + 7) * 2;
        mem.b5[a] = 2;
        mem.b5[a + 1] = 0x20;                       // dlaždice 2, paleta +2
        mem.b5[0x0c00 + 2 * 32 + 1 * 4 + 1] = 0x0c; // řádek 1, pixel 3 = C
        const p = palBank((i) => i * 3);
        const lut = TM.colourLut(p, cfg);
        const buf = TM.renderMap(mem, cfg, mb, db, lut);
        assert.equal(buf.length, 320 * 256);
        assert.equal(buf[(5 * 8 + 1) * 320 + 7 * 8 + 3], rgba(p[0x2c]));
        assert.equal(buf[(5 * 8 + 1) * 320 + 7 * 8 + 2], 0, 'nibble 0 = průhledný NR $4C');
        const d = TM.renderDefs(mem, cfg, db, lut, 512, 1);
        assert.equal(d.w, 16 * 9 - 1);
        assert.equal(d.h, 32 * 9 - 1);
        assert.equal(d.buf[(0 * 9 + 1) * d.w + 2 * 9 + 3], rgba(p[0x1c]));
    });

    test('visibleRects 40 a 80 sloupců, ořez', () => {
        eq(TM.visibleRects({ cols: 40 }, 0, 0, null).rects, [{ x: 0, y: 0, w: 320, h: 256 }]);
        const v = TM.visibleRects({ cols: 80 }, 100, 10, { x1: 0, x2: 0x9f, y1: 0, y2: 255 });
        assert.equal(v.rects.reduce((s: number, r: any) => s + r.w * r.h, 0), 640 * 256);
        eq(v.origin, { x: 100, y: 10 });
        eq(TM.visibleRects({ cols: 40 }, 0, 0, { x1: 4, x2: 10, y1: 8, y2: 20 }).rects, [{ x: 8, y: 8, w: 14, h: 13 }]);
    });
});

describe('Vrstvy: pořadí podle NR $15', () => {
    const texts = dictionary('en', AREAS);
    const T = translator(texts);
    const LY = loadViews(['layers.js'], 'en', texts, ['layerOrder', 'enables']).x;
    test('pořadí, LoRes, stencil, míchání', () => {
        const nr = new Uint8Array(256);
        const o = (v15: number, v68 = 0, v6b = 0) => {
            nr[0x15] = v15;
            nr[0x68] = v68;
            nr[0x6b] = v6b;
            return LY.layerOrder(nr);
        };
        eq(o(0).order.map((i: any) => i.key), ['S', 'L', 'U', 'B']);
        eq(o(1 << 2).order.map((i: any) => i.key), ['L', 'S', 'U', 'B']);
        eq(o(5 << 2).order.map((i: any) => i.key), ['U', 'L', 'S', 'B']);
        assert.equal(o(3 << 2).name, 'LUS');
        assert.ok(o(0x80).order[2].text.startsWith('LoRes'));
        assert.equal(o(0, 0x01, 0x80).order[2].text, T('layers.ulaStencil', 'ULA'));
        assert.equal(o(0, 0x00, 0x80).order[2].text, T('layers.ulaPlusTm', 'ULA'));
        const b = o(6 << 2);
        eq(b.order.map((i: any) => i.key), ['U', 'S', 'U', 'L', 'B']);
        assert.equal(b.order[3].text, T('layers.blendAdd', 'ULA'));
        eq(o(7 << 2, 2 << 5).order.map((i: any) => i.key), ['S', 'L', 'B']);
    });
});

for (const lang of TEST_LANGS) {
    describe(`pohledy Layer 2 / Tilemapa / Vrstvy nad DOM [${lang}]`, () => {
        const texts = dictionary(lang, AREAS);
        const T = translator(texts);
        const head = (key: string) => T(key).split(/\{\d+\}/)[0];
        const scan = (el: FakeElement, def: any, where: string) => checkTexts([...domStrings(el), def.title], lang, AREAS, where);

        test('Layer 2: mount/refresh/hover ve všech režimech, stínová banka, ořez', async () => {
            const MODES = loadViews(['layer2.js'], lang, texts, ['MODES']).x.MODES;
            for (const [mode, shadow] of [[0, false], [1, true], [2, false]] as Array<[number, boolean]>) {
                const v = loadViews(['layer2.js'], lang, texts).defs.layer2;
                const nr = new Uint8Array(256);
                nr[0x12] = 9; nr[0x13] = 12; nr[0x70] = (mode << 4) | 1; nr[0x14] = 0xe3; nr[0x69] = 0x80; nr[0x43] = 0x04;
                nr[0x16] = 20; nr[0x71] = 1; nr[0x17] = 7;
                const pages: Record<number, Uint8Array> = {};
                const bank = shadow ? 12 : 9;
                for (let p = 0; p < 10; p++) pages[bank * 2 + p] = new Uint8Array(0x2000).fill(0x10 + p);
                const banks = { layer2_0: palBank(() => 0), layer2_1: palBank((i) => i * 2 + 1) };
                const api = makeApi(lang, texts, makeServer({ nr, banks, pages, long: true, clips: mode === 1 ? { layer2: { x1: 0, x2: 159, y1: 0, y2: 255 } } : undefined }));
                const el = new FakeElement('div');
                v.mount(el, api);
                if (shadow) {
                    const sel = findAll(el, byTag('select'))[0];
                    sel.value = '1';
                    sel.fire('change');
                    await tick();
                }
                await v.refresh(api);
                const cv = findAll(el, byTag('canvas'))[0];
                assert.equal(cv.width, MODES[mode].w);
                assert.equal(cv.image!.height, MODES[mode].h);
                assert.equal(api.log.filter((l) => l[0] === 'readMemory')[0][1].page, bank * 2);
                const u32 = new Uint32Array(cv.image!.data.buffer);
                // první bajt 0x10 → index ((1 + 1) & 15) << 4 | 0 = 0x20 (8 bpp) / 0x11 (4 bpp: posun 1, nibble 1)
                assert.equal(u32[0], rgba(banks.layer2_1[mode === 2 ? 0x11 : 0x20]));
                cv.fire('mousemove', { clientX: 1, clientY: 1 });
                const hov = findAll(el, hasClass('hover'))[0];
                assert.ok(hov.textContent.includes(T('layer2.hoverBank').split('{1}')[0].replace('{0}', String(bank))), hov.textContent);
                const info = findAll(el, hasClass('info'))[0].textContent;
                assert.ok(info.includes(T('layer2.on')), info);
                assert.ok(info.includes(T('layer2.infoScroll').split('{1}')[0].replace('{0}', '276')), info);
                assert.ok(findAll(el, (e) => e.className === 'vis').length >= 1);
                scan(el, v, 'L2 režim ' + mode);
            }
        });

        test('Layer 2: nibbly, průhlednost, vypnutá, bez sezení, chyba', async () => {
            const v = loadViews(['layer2.js'], lang, texts).defs.layer2;
            const nr = new Uint8Array(256);
            nr[0x12] = 9; nr[0x70] = 0x20; nr[0x14] = 0x00; nr[0x69] = 0x00; nr[0x1c] = 2;
            const pages: Record<number, Uint8Array> = {};
            for (let p = 0; p < 10; p++) pages[18 + p] = new Uint8Array(0x2000).fill(0x01);
            const api = makeApi(lang, texts, makeServer({ nr, banks: { layer2_0: palBank((i) => i * 2), layer2_1: palBank(() => 0) }, pages, long: true }));
            const el = new FakeElement('div');
            v.mount(el, api);
            await v.refresh(api);
            const cv = findAll(el, byTag('canvas'))[0];
            const hov = findAll(el, hasClass('hover'))[0];
            cv.fire('mousemove', { clientX: 0.1, clientY: 0 });   // x 0 → vyšší nibble 0 → index 0 → barva 0 = průhledná
            assert.ok(hov.textContent.includes(T('layer2.hoverByteHigh', '$01', 0)) && hov.textContent.endsWith(' ' + T('layer2.transparent')), hov.textContent);
            scan(el, v, 'L2 vyšší nibble');
            cv.fire('mousemove', { clientX: 1.6, clientY: 0 });   // x 1 → nižší nibble 1
            assert.ok(hov.textContent.includes(T('layer2.hoverByteLow', '$01', 1)), hov.textContent);
            const info = findAll(el, hasClass('info'))[0].textContent;
            assert.ok(info.includes(T('layer2.off')) && info.includes(T('layer2.clipPart', 'Y1', '$00')), info);
            assert.ok(info.includes(T('layer2.infoPalFirst', 0, '$00')), info);
            scan(el, v, 'L2 nižší nibble');

            const v2 = loadViews(['layer2.js'], lang, texts).defs.layer2;
            const api2 = makeApi(lang, texts, () => { throw new Error('boom'); });
            api2.state = { attached: false, paused: false };
            const el2 = new FakeElement('div');
            v2.mount(el2, api2);
            const info2 = findAll(el2, hasClass('info'))[0];
            assert.equal(info2.textContent, T('layer2.noSession'));
            api2.state = { attached: true, paused: true };
            const sel = findAll(el2, byTag('select'))[0];
            sel.value = '1';
            sel.fire('change');
            await tick(); await tick(); await tick();
            assert.equal(info2.textContent, T('layer2.error', 'boom'));
            scan(el2, v2, 'L2 chyba');
        });

        test('Tilemapa: mount/refresh/hover (banka 5 i 7, server po jedné stránce)', async () => {
            for (const [v6b, v6e, v6f, long] of [[0x80, 0x2c, 0x0c, false], [0xc2, 0x81, 0x00, true], [0x88, 0x2c, 0x8c, true]] as Array<[number, number, number, boolean]>) {
                const v = loadViews(['tilemap.js'], lang, texts).defs.tilemap;
                const nr = nrTm(v6b, { 0x6e: v6e, 0x6f: v6f, 0x30: 5, 0x2f: 1, 0x31: 3 });
                const pages: Record<number, Uint8Array> = {};
                for (const p of [10, 11, 14]) {
                    pages[p] = new Uint8Array(0x2000);
                    for (let i = 0; i < 0x2000; i++) pages[p][i] = (i * 13 + p) & 255;
                }
                const api = makeApi(lang, texts, makeServer({ nr, banks: { tilemap0: palBank((i) => i), tilemap1: palBank((i) => 511 - i) }, pages, long }));
                const el = new FakeElement('div');
                v.mount(el, api);
                await v.refresh(api);
                const [cv, dv] = findAll(el, byTag('canvas'));
                assert.equal(cv.width, (v6b & 0x40 ? 80 : 40) * 8);
                assert.ok(cv.image && dv.image);
                assert.equal(dv.image!.height, (v6b & 2 ? 32 : 16) * 9 - 1);
                const pg = api.log.filter((l) => l[0] === 'readMemory').map((l) => l[1].page);
                if (v6e & 0x80 || v6f & 0x80) assert.ok(pg.includes(14), 'čte banku 7');
                if (!(v6e & 0x80) || !(v6f & 0x80)) assert.ok(pg.includes(10), 'čte banku 5');
                cv.fire('mousemove', { clientX: 30, clientY: 30 });
                const hov = findAll(el, hasClass('hover'))[0];
                assert.ok(hov.textContent.includes(head('tilemap.hoverTile')), hov.textContent);
                assert.ok(api.highlights.length && api.highlights.at(-1).w > 0);
                dv.fire('mousemove', { clientX: 10, clientY: 10 });
                scan(el, v, 'TM $6B=' + v6b.toString(16));
                cv.fire('mouseleave');
                assert.equal(api.highlights.at(-1), null);
            }
        });

        test('Tilemapa: bez atributů, vypnutá, navrchu, bez sezení', async () => {
            for (const v6b of [0xe1, 0x00, 0x8f, 0x96]) {
                const v = loadViews(['tilemap.js'], lang, texts).defs.tilemap;
                const nr = nrTm(v6b, { 0x6c: 0x0e, 0x1c: 0x80 });
                const pages: Record<number, Uint8Array> = {};
                for (const p of [10, 11, 14]) pages[p] = new Uint8Array(0x2000).fill(0x5e);
                const api = makeApi(lang, texts, makeServer({ nr, banks: { tilemap0: palBank((i) => i), tilemap1: palBank((i) => i) }, pages, long: true }));
                const el = new FakeElement('div');
                v.mount(el, api);
                await v.refresh(api);
                const [cv, dv] = findAll(el, byTag('canvas'));
                cv.fire('mousemove', { clientX: 5, clientY: 5 });
                dv.fire('mousemove', { clientX: 2, clientY: 2 });
                const info = findAll(el, hasClass('info'))[0].textContent;
                assert.ok(info.includes(T(v6b & 0x80 ? 'tilemap.on' : 'tilemap.off')), info);
                if (v6b & 0x20) assert.ok(info.includes(T('tilemap.noAttr', '$0E')), info);
                scan(el, v, 'TM $6B=' + v6b.toString(16));
            }
            const v = loadViews(['tilemap.js'], lang, texts).defs.tilemap;
            const api = makeApi(lang, texts, () => { throw new Error('boom'); });
            api.state = { attached: false, paused: false };
            const el = new FakeElement('div');
            v.mount(el, api);
            assert.equal(findAll(el, hasClass('info'))[0].textContent, T('tilemap.noSession'));
            scan(el, v, 'TM bez sezení');
        });

        test('Vrstvy: mount/refresh, přepínání vrstev, náhledy, popisky', async () => {
            const v = loadViews(['layers.js'], lang, texts).defs.layers;
            const nr = new Uint8Array(256);
            nr[0x15] = 0x05; nr[0x69] = 0x80; nr[0x1c] = 0x00;
            const api = makeApi(lang, texts, makeServer({ nr, banks: {} }));
            const el = new FakeElement('div');
            v.mount(el, api);
            await v.refresh(api);
            const cvs = findAll(el, byTag('canvas'));
            assert.equal(cvs.length, 9);
            assert.ok(cvs[0].image);
            assert.equal(cvs[0].image!.data[1 * 4 + 3], 255);
            assert.equal(cvs[0].image!.data[3], 0);
            cvs[0].fire('mousemove', { clientX: 100, clientY: 50 });
            const hov = findAll(el, hasClass('hover'))[0];
            assert.match(hov.textContent, /x 50, y 25/);
            const info = findAll(el, (e) => e.className === 'info')[0].textContent;
            assert.ok(info.includes('LSU') && info.includes(T('layers.sprites') + ' (NR $19)X $00–$FF'), info);
            scan(el, v, 'Vrstvy');
            const box = findAll(el, byTag('input'))[0];
            box.checked = true;
            box.fire('change');
            await tick(); await tick(); await tick();
            await v.refresh(api);
            const rl = api.log.filter((l) => l[0] === 'renderLayer').map((l) => l[1].layer);
            assert.ok(rl.includes('background') && rl.includes('ulaShadow'), rl.join());
            assert.ok(cvs.slice(1).every((c) => c.image), 'všechny náhledy nakreslené');
            findAll(el, (e) => e.className === 'thumb')[5].fire('click');
            await tick(); await tick();
            await v.refresh(api);
            assert.equal(api.log.filter((l) => l[0] === 'renderLayer').at(-1)![1].layer, 'sprites');
            cvs[3].fire('mousemove', { clientX: 10, clientY: 10 });
            assert.ok(hov.textContent.startsWith(T('layers.hoverLabel', T('layers.ulaShadow'), '').trimEnd()), hov.textContent);
            scan(el, v, 'Vrstvy náhledy');
        });

        test('Vrstvy: všechna pořadí NR $15 a stavy vrstev, bez sezení, chyba', async () => {
            const LY = loadViews(['layers.js'], lang, texts, ['layerOrder']).x;
            for (let p = 0; p < 8; p++) {
                for (const [v15, v68, v69, v6b] of [[0x43, 0x81, 0x00, 0x81], [0x80, 0x00, 0x80, 0x80], [0x02, 0x41, 0x80, 0x00], [0x01, 0x60, 0x00, 0x81]]) {
                    const v = loadViews(['layers.js'], lang, texts).defs.layers;
                    const nr = new Uint8Array(256);
                    nr[0x15] = v15 | (p << 2); nr[0x68] = v68; nr[0x69] = v69; nr[0x6b] = v6b; nr[0x1c] = 0x1b;
                    const api = makeApi(lang, texts, makeServer({ nr, banks: {}, clips: p & 1 ? { layer2: { x1: 0, x2: 255, y1: 0, y2: 191 } } : undefined }));
                    const el = new FakeElement('div');
                    v.mount(el, api);
                    await v.refresh(api);
                    findAll(el, byTag('canvas'))[0].fire('mousemove', { clientX: 3, clientY: 0 });
                    const info = findAll(el, (e) => e.className === 'info')[0].textContent;
                    assert.ok(info.includes(T('layers.orderTitle', '$' + nr[0x15].toString(16).toUpperCase().padStart(2, '0'), LY.layerOrder(nr).name)), info);
                    scan(el, v, 'Vrstvy p=' + p);
                }
            }
            const v = loadViews(['layers.js'], lang, texts).defs.layers;
            const api = makeApi(lang, texts, () => { throw new Error('boom'); });
            api.state = { attached: false, paused: false };
            const el = new FakeElement('div');
            v.mount(el, api);
            const msg = findAll(el, (e) => e.className === 'muted')[0];
            assert.equal(msg.textContent, T('layers.noSession'));
            api.state = { attached: true, paused: true };
            const sel = findAll(el, byTag('select'))[0];
            sel.value = 'ula';
            sel.fire('change');
            await tick(); await tick(); await tick();
            assert.equal(msg.textContent, T('layers.error', 'boom'));
            scan(el, v, 'Vrstvy chyba');
        });
    });
}
