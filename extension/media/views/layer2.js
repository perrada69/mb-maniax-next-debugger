// Pohled „Layer 2“: celý obsah Layer 2 z paměti (ne jen viditelná část) s vyznačeným výřezem.
// Hardware podle JNEXT video/layer2.cpp:479-860 (režimy NR $70, adresy, paleta, průhlednost, scroll, ořez).
(function () {
    'use strict';

    const ID = 'layer2';
    const PAGE = 0x2000;      // 8K stránka
    const CHUNK = 0x10000;    // nejvýš na jeden dotaz (smlouva dovoluje 0x30000, starší server 1 stránku)

    // Režimy NR $70 b5:4 (layer2.cpp:479-484; 2 i 3 = 640 × 256, layer2.cpp:765)
    const MODES = [
        { w: 256, h: 192, size: 0xc000, name: '256 × 192, 8 bpp' },
        { w: 320, h: 256, size: 0x14000, name: NextView.t('layer2.columnMajor', '320 × 256, 8 bpp') },
        { w: 640, h: 256, size: 0x14000, name: NextView.t('layer2.columnMajor', '640 × 256, 4 bpp') },
    ];

    const CSS = `
#view-layer2 .stage { position: relative; display: inline-block; line-height: 0; }
#view-layer2 .checker {
    background-color: #808080;
    background-image: conic-gradient(#9a9a9a 0 25%, #6a6a6a 0 50%, #9a9a9a 0 75%, #6a6a6a 0);
    background-size: 16px 16px;
}
#view-layer2 .vis { position: absolute; box-sizing: border-box; border: 1px dashed var(--vscode-focusBorder); pointer-events: none; }
#view-layer2 .origin { position: absolute; width: 7px; height: 7px; margin: -3px 0 0 -3px; box-sizing: border-box;
    border: 2px solid var(--vscode-focusBorder); border-radius: 50%; pointer-events: none; }
#view-layer2 .info { margin-bottom: 6px; line-height: 1.5; }
#view-layer2 .info .sw { margin: 0 2px 0 4px; }
#view-layer2 .hover { min-height: 1.4em; margin: 4px 0; }
#view-layer2 .warn { color: var(--vscode-editorWarning-foreground); }
`;

    // 3bitová složka → 8 bitů (smlouva: (c << 5) | (c << 2) | (c >> 1))
    const C3 = [];
    for (let c = 0; c < 8; c++) C3.push((c << 5) | (c << 2) | (c >> 1));

    function rgba32(c9) {
        return ((255 << 24) | (C3[c9 & 7] << 16) | (C3[(c9 >> 3) & 7] << 8) | C3[(c9 >> 6) & 7]) >>> 0;
    }

    // ---- dekódování (testovatelné, bez DOM)

    // Barvy podle bajtu/nibblu pixelu: offset palety a průhlednost (RRRGGGBB palety == NR $14).
    // 8 bpp: index = ((p >> 4) + offset) << 4 | p & 15 (layer2.cpp:653, :749);
    // 4 bpp: index = offset << 4 | nibble (layer2.cpp:840); RRRGGGBB = RGB333 >> 1 (palette.h:313-319).
    function colourLut(mode, pal, offset, transp) {
        const n = mode >= 2 ? 16 : 256;
        const lut = new Uint32Array(n);
        const idx = new Uint8Array(n);
        for (let p = 0; p < n; p++) {
            const i = mode >= 2 ? ((offset << 4) | p) & 0xff : ((((p >> 4) + offset) & 15) << 4) | (p & 15);
            const c = pal[i] | 0;
            idx[p] = i;
            lut[p] = (c >> 1) === transp ? 0 : rgba32(c);
        }
        return { lut, idx };
    }

    // Adresa bajtu pixelu (x, y) v datech vrstvy (layer2.cpp:493-496):
    // 256×192 po řádcích y·256 + x, 320×256 po sloupcích x·256 + y, 640×256 (x/2)·256 + y
    function pixelAddr(mode, x, y) {
        if (mode === 0) return y * 256 + x;
        if (mode === 1) return x * 256 + y;
        return (x >> 1) * 256 + y;
    }

    // Celá vrstva → Uint32Array RGBA (alfa 0 = průhledné)
    function decode(mem, mode, lut, out) {
        const m = MODES[Math.min(mode, 2)];
        const w = m.w;
        const h = m.h;
        const px = out || new Uint32Array(w * h);
        const len = mem.length;
        if (mode === 0) {
            for (let i = 0; i < w * h; i++) px[i] = i < len ? lut[mem[i]] : 0;
        } else if (mode === 1) {
            for (let x = 0; x < w; x++) {
                const base = x * 256;
                for (let y = 0; y < h; y++) {
                    const a = base + y;
                    px[y * w + x] = a < len ? lut[mem[a]] : 0;
                }
            }
        } else {
            // vyšší nibble = levý pixel (layer2.cpp:839, :849)
            for (let c = 0; c < 320; c++) {
                const base = c * 256;
                for (let y = 0; y < h; y++) {
                    const a = base + y;
                    const b = a < len ? mem[a] : 0;
                    const o = y * w + c * 2;
                    px[o] = a < len ? lut[b >> 4] : 0;
                    px[o + 1] = a < len ? lut[b & 15] : 0;
                }
            }
        }
        return px;
    }

    // Viditelná část v souřadnicích dat: obrazovka (ořez) posunutá o scroll, zalomená na rozměr vrstvy.
    // 256×192: X & 255, Y mod 192, ořez přímo (layer2.cpp:587-650); široké režimy: X mod 320 (sloupce),
    // Y & 255, ořez X1·2 … X2·2+1 ve sloupcích (layer2.cpp:700-742, :783-832). Vrací obdélníky v pixelech dat.
    function visibleRects(mode, sx, sy, clip) {
        const narrow = mode === 0;
        const cw = narrow ? 256 : 320;        // šířka ve sloupcích (adresách X)
        const ch = narrow ? 192 : 256;
        const px = mode >= 2 ? 2 : 1;         // pixelů na sloupec
        let x1 = 0;
        let x2 = cw - 1;
        let y1 = 0;
        let y2 = ch - 1;
        if (clip) {
            x1 = narrow ? clip.x1 : clip.x1 * 2;
            x2 = Math.min(cw - 1, narrow ? clip.x2 : clip.x2 * 2 + 1);
            y1 = clip.y1;
            y2 = Math.min(ch - 1, clip.y2);
        }
        if (x1 > x2 || y1 > y2) return { rects: [], origin: null };
        const ox = (narrow ? sx & 0xff : sx) % cw;
        const oy = (narrow ? sy : sy & 0xff) % ch;
        const rects = [];
        const spans = (a, b, o, size) => {
            const s = (a + o) % size;
            const e = s + (b - a);
            return e < size ? [[s, e]] : [[s, size - 1], [0, e - size]];
        };
        for (const [xa, xb] of spans(x1, x2, ox, cw)) {
            for (const [ya, yb] of spans(y1, y2, oy, ch)) {
                rects.push({ x: xa * px, y: ya, w: (xb - xa + 1) * px, h: yb - ya + 1 });
            }
        }
        return { rects, origin: { x: ox * px, y: oy } };
    }

    // ---- data ze serveru

    // Souvislé 8K stránky od `page`; když server neumí dlouhé čtení, čte po stránkách (a pamatuje si to).
    let longReads = true;
    async function readPages(api, page, length) {
        const out = new Uint8Array(length);
        const jobs = [];
        const step = longReads ? CHUNK : PAGE;
        for (let off = 0; off < length; off += step) {
            const n = Math.min(step, length - off);
            jobs.push(api.request('readMemory', { page: page + off / PAGE, addr: 0, length: n })
                .then((r) => api.bytes(r.data))
                .catch(() => null)
                .then(async (d) => {
                    if (d && d.length >= n) {
                        out.set(d.subarray(0, n), off);
                        return;
                    }
                    if (n > PAGE) longReads = false;
                    // záložně po jedné stránce
                    const parts = [];
                    for (let p = 0; p < n; p += PAGE) {
                        parts.push(api.request('readMemory', { page: page + (off + p) / PAGE, addr: 0, length: Math.min(PAGE, n - p) })
                            .then((r) => out.set(api.bytes(r.data).subarray(0, Math.min(PAGE, n - p)), off + p)));
                    }
                    await Promise.all(parts);
                }));
        }
        await Promise.all(jobs);
        return out;
    }

    // Přeložený text s uzly DOM na místě {0}, {1} … (pole dětí pro api.el)
    function fill(key, ...args) {
        return api.t(key).split(/\{(\d+)\}/).map((p, i) => (i & 1 ? args[+p] : p));
    }

    // ---- stav pohledu
    let api = null;
    let shadow = false;
    let zoom = 2;
    let showVis = true;
    let busy = null;
    let last = null;      // {mode, w, h, bank, mem, lut, idx, nr}
    let ctx = null;
    let img = null;
    const els = {};

    function mount(el, a) {
        api = a;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        els.bank = api.el('select', { title: api.t('layer2.bankTip'), onChange: () => {
            shadow = els.bank.value === '1';
            reload();
        } }, api.el('option', { value: '0' }, api.t('layer2.bankActive')), api.el('option', { value: '1' }, api.t('layer2.bankShadow')));
        els.zoom = api.el('select', { title: api.t('layer2.zoom'), onChange: () => {
            zoom = +els.zoom.value;
            layout();
        } }, api.el('option', { value: '1' }, '1×'), api.el('option', { value: '2' }, '2×'));
        els.zoom.value = String(zoom);
        els.vis = api.el('input', { type: 'checkbox', onChange: () => {
            showVis = els.vis.checked;
            layout();
        } });
        els.vis.checked = showVis;
        el.appendChild(api.el('div', { class: 'toolbar' }, els.bank, els.zoom,
            api.el('label', { title: api.t('layer2.visibleTip') }, els.vis, ' ' + api.t('layer2.visible'))));

        els.info = api.el('div', { class: 'info mono' });
        els.canvas = api.canvas(256, 192, zoom);
        els.canvas.classList.add('checker');
        els.overlay = api.el('div');
        els.stage = api.el('div', { class: 'stage' }, els.canvas, els.overlay);
        els.hover = api.el('div', { class: 'hover mono muted' });
        el.appendChild(els.info);
        el.appendChild(els.stage);
        el.appendChild(els.hover);
        els.canvas.addEventListener('mousemove', onHover);
        els.canvas.addEventListener('mouseleave', () => {
            els.hover.textContent = '';
        });
        if (!api.state.attached) els.info.textContent = api.t('layer2.noSession');
    }

    // CSS pixelů na pixel dat (prostor 320 × 256 · zoom; 640 režim má poloviční pixely)
    function cssScale() {
        return last && last.mode >= 2 ? zoom / 2 : zoom;
    }

    function layout() {
        if (!last) return;
        const s = cssScale();
        els.canvas.style.width = last.w * s + 'px';
        els.canvas.style.height = last.h * s + 'px';
        const boxes = [];
        if (showVis && last.vis) {
            for (const r of last.vis.rects) {
                const d = api.el('div', { class: 'vis' });
                d.style.left = r.x * s + 'px';
                d.style.top = r.y * s + 'px';
                d.style.width = r.w * s + 'px';
                d.style.height = r.h * s + 'px';
                boxes.push(d);
            }
            if (last.vis.origin) {
                const o = api.el('div', { class: 'origin', title: api.t('layer2.origin') });
                o.style.left = last.vis.origin.x * s + 'px';
                o.style.top = last.vis.origin.y * s + 'px';
                boxes.push(o);
            }
        }
        els.overlay.replaceChildren(...boxes);
    }

    function onHover(e) {
        if (!last) return;
        const r = els.canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const x = Math.min(last.w - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * last.w)));
        const y = Math.min(last.h - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * last.h)));
        const a = pixelAddr(last.mode, x, y);
        const b = last.mem[a] | 0;
        const p = last.mode >= 2 ? (x & 1 ? b & 15 : b >> 4) : b;
        const i = last.idx[p];
        const c9 = last.pal[i] | 0;
        const bank = last.bank + (a >> 14);
        const t = last.lut[p] === 0 ? ' ' + api.t('layer2.transparent') : '';
        els.hover.textContent = ['x ' + x + ', y ' + y,
            api.t('layer2.hoverBank', bank, api.hex(a & 0x3fff, 4), last.bank * 2 + (a >> 13), api.hex(a & 0x1fff, 4)),
            last.mode >= 2 ? api.t(x & 1 ? 'layer2.hoverByteLow' : 'layer2.hoverByteHigh', api.hex(b), p) : api.t('layer2.hoverByte', api.hex(b)),
            api.t('layer2.hoverIndex', api.hex(i)),
            api.css(c9) + ' (RGB333 ' + api.hex(c9, 3) + ')' + t].join('  ·  ');
    }

    function reload() {
        if (!api || !api.state.attached) return;
        refresh(api).catch((e) => {
            els.info.textContent = api.t('layer2.error', (e && e.message) || e);
        });
    }

    function infoLine(nr, nrRes, mode, bank, sx, sy, pal2, off) {
        const on = (nr[0x69] & 0x80) !== 0;
        const idx = nr[0x1c] & 3;
        const clip = nrRes.clips && nrRes.clips.layer2;
        const clipText = clip
            ? 'X ' + api.hex(clip.x1) + '–' + api.hex(clip.x2) + ', Y ' + api.hex(clip.y1) + '–' + api.hex(clip.y2)
            : api.t('layer2.clipPart', ['X1', 'X2', 'Y1', 'Y2'][idx], api.hex(nr[0x18]));
        const transp = nr[0x14];
        const sw = api.el('span', { class: 'swatch sw', title: api.t('layer2.transparentTip') });
        sw.style.background = api.css(transp << 1);
        const pages = bank * 2 + '–' + (bank * 2 + MODES[mode].size / PAGE - 1);
        els.info.replaceChildren(
            api.el('div', null, fill('layer2.infoMode', api.el('b', null, MODES[mode].name), api.hex(nr[0x70]),
                api.el('span', { class: on ? '' : 'warn' }, api.t(on ? 'layer2.on' : 'layer2.off')))),
            api.el('div', null, api.t(shadow ? 'layer2.infoBankShadow' : 'layer2.infoBankActive', bank, pages,
                nr[0x12] & 0x7f, nr[0x13] & 0x7f)),
            api.el('div', null, api.t('layer2.infoScroll', sx, sy, clipText)),
            api.el('div', null, api.t(pal2 ? 'layer2.infoPalSecond' : 'layer2.infoPalFirst', off, api.hex(transp)), sw));
    }

    async function load(a) {
        const [nrRes, pals] = await Promise.all([a.request('nextregs'), a.request('palettes')]);
        const nr = a.bytes(nrRes.data);
        const mode = Math.min((nr[0x70] >> 4) & 3, 2);
        const m = MODES[mode];
        const bank = (shadow ? nr[0x13] : nr[0x12]) & 0x7f;      // layer2.h:45-56
        const mem = await readPages(a, bank * 2, m.size);
        const pal2 = (nr[0x43] & 0x04) !== 0;                    // emulator.cpp:2223-2234
        const pal = (pals.banks && pals.banks[pal2 ? 'layer2_1' : 'layer2_0']) || [];
        const off = nr[0x70] & 15;
        const { lut, idx } = colourLut(mode, pal, off, nr[0x14]);
        const sx = ((nr[0x71] & 1) << 8) | nr[0x16];
        const sy = nr[0x17];

        if (!img || img.width !== m.w || img.height !== m.h) {
            els.canvas.width = m.w;
            els.canvas.height = m.h;
            ctx = els.canvas.getContext('2d');
            img = ctx.createImageData(m.w, m.h);
        }
        decode(mem, mode, lut, new Uint32Array(img.data.buffer));
        ctx.putImageData(img, 0, 0);

        const clip = nrRes.clips && nrRes.clips.layer2;
        last = { mode, w: m.w, h: m.h, bank, mem, lut, idx, pal, vis: visibleRects(mode, sx, sy, clip || null) };
        infoLine(nr, nrRes, mode, bank, sx, sy, pal2, off);
        layout();
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.info.textContent = api.t('layer2.noSession');
            return;
        }
        while (busy) await busy.catch(() => {});
        busy = load(a);
        try {
            await busy;
        } finally {
            busy = null;
        }
    }

    NextView.register({ id: ID, title: NextView.t('layer2.title'), order: 50, mount, refresh });
})();
