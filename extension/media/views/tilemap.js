// Pohled „Tilemapa“: celá mapa 40×32 / 80×32 s vyznačeným výřezem a sada definic dlaždic.
// Hardware podle JNEXT video/tilemap.cpp:225-251 (adresy v bance 5/7) a :336-700 (vykreslení).
(function () {
    'use strict';

    const ID = 'tilemap';
    const ROWS = 32;
    const GRID_COLS = 16;   // dlaždic na řádek v sadě definic
    const CELL = 9;         // 8 px + 1 px mezera

    const CSS = `
#view-tilemap .stage { position: relative; display: inline-block; line-height: 0; }
#view-tilemap .checker {
    background-color: #808080;
    background-image: conic-gradient(#9a9a9a 0 25%, #6a6a6a 0 50%, #9a9a9a 0 75%, #6a6a6a 0);
    background-size: 16px 16px;
}
#view-tilemap .vis { position: absolute; box-sizing: border-box; border: 1px dashed var(--vscode-focusBorder); pointer-events: none; }
#view-tilemap .origin { position: absolute; width: 7px; height: 7px; margin: -3px 0 0 -3px; box-sizing: border-box;
    border: 2px solid var(--vscode-focusBorder); border-radius: 50%; pointer-events: none; }
#view-tilemap .mark { position: absolute; box-sizing: border-box; border: 2px solid var(--vscode-focusBorder); pointer-events: none; }
#view-tilemap .info { margin-bottom: 6px; line-height: 1.5; }
#view-tilemap .hover { min-height: 2.9em; margin: 4px 0; white-space: pre-wrap; }
#view-tilemap h4 { margin: 12px 0 4px; font-weight: normal; color: var(--vscode-descriptionForeground); }
#view-tilemap .warn { color: var(--vscode-editorWarning-foreground); }
#view-tilemap .defs-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
#view-tilemap input[type='number'] { width: 4em; }
`;

    // 3bitová složka → 8 bitů (smlouva: (c << 5) | (c << 2) | (c >> 1))
    const C3 = [];
    for (let c = 0; c < 8; c++) C3.push((c << 5) | (c << 2) | (c >> 1));

    function rgba32(c9) {
        return ((255 << 24) | (C3[c9 & 7] << 16) | (C3[(c9 >> 3) & 7] << 8) | C3[(c9 >> 6) & 7]) >>> 0;
    }

    // ---- dekódování (testovatelné, bez DOM)

    // NR $6B (tilemap.cpp:72-89): b7 zapnutá, b6 80 sloupců, b5 bez atributů (NR $6C), b4 paleta,
    // b3 textový režim, b1 512 dlaždic, b0 tilemapa vždy nad ULA
    function control(nr) {
        const v = nr[0x6b];
        return {
            on: (v & 0x80) !== 0,
            cols: v & 0x40 ? 80 : 40,
            noAttr: (v & 0x20) !== 0,
            pal2: (v & 0x10) !== 0,
            text: (v & 0x08) !== 0,
            t512: (v & 0x02) !== 0,
            onTop: (v & 0x01) !== 0,
            defAttr: nr[0x6c],
            transp: nr[0x4c] & 15,
            nr14: nr[0x14],
        };
    }

    // NR $6E/$6F: b7 = banka 7 (jen 8K BRAM), b5:0 = posun po 256 B (tilemap.cpp:241-251, :225-239)
    function base(v) {
        return { bank7: (v & 0x80) !== 0, off: (v & 0x3f) << 8 };
    }

    // Čtení z banky 5 (16K) nebo 7 (8K) se zalomením jako vram_read
    function vread(mem, b, off) {
        return b.bank7 ? mem.b7[off & 0x1fff] | 0 : mem.b5[off & 0x3fff] | 0;
    }

    // Položka mapy (col, row) → {addr, tile, attr} (tilemap.cpp:531-571)
    function mapEntry(mem, cfg, mb, col, row) {
        const size = cfg.noAttr ? 1 : 2;
        const addr = mb.off + (row * cfg.cols + col) * size;
        const tile = vread(mem, mb, addr);
        const attr = cfg.noAttr ? cfg.defAttr : vread(mem, mb, addr + 1);
        return { addr, tile: cfg.t512 ? tile | ((attr & 1) << 8) : tile, attr };
    }

    // Rozpis atributu (tilemap.cpp:548-585)
    function attrInfo(cfg, attr) {
        if (cfg.text) return { pal: (attr >> 1) & 0x7f, xm: false, ym: false, rot: false, bit0: attr & 1 };
        return { pal: attr >> 4, xm: (attr & 8) !== 0, ym: (attr & 4) !== 0, rot: (attr & 2) !== 0, bit0: attr & 1 };
    }

    // Dlaždice → 64 indexů palety, −1 = průhledné (tilemap.cpp:597-690).
    // Bez rotace: ex = xm ? 7−x : x, ey = ym ? 7−y : y, bajt = def[ey·4 + ex/2].
    // S rotací: ex = (xm ^ 1) ? 7−x : x, pak prohození: bajt = def[ex·4 + ey/2], nibble podle ey.
    // Textový režim: 8 B na dlaždici, bit 7 vlevo, index = pal·2 | bit, průhlednost až podle NR $14.
    function tilePixels(mem, cfg, db, tile, attr, out) {
        const px = out || new Int16Array(64);
        const a = attrInfo(cfg, attr);
        if (cfg.text) {
            const base8 = db.off + tile * 8;
            for (let y = 0; y < 8; y++) {
                const row = vread(mem, db, base8 + y);
                for (let x = 0; x < 8; x++) px[y * 8 + x] = ((a.pal << 1) | ((row >> (7 - x)) & 1)) & 0xff;
            }
            return px;
        }
        const base32 = db.off + tile * 32;
        const exm = a.xm !== a.rot;
        const hi = a.pal << 4;
        for (let y = 0; y < 8; y++) {
            const ey = a.ym ? 7 - y : y;
            for (let x = 0; x < 8; x++) {
                const ex = exm ? 7 - x : x;
                let r;
                let c;
                if (a.rot) {
                    r = ex;
                    c = ey;
                } else {
                    r = ey;
                    c = ex;
                }
                const b = vread(mem, db, base32 + r * 4 + (c >> 1));
                const n = c & 1 ? b & 15 : b >> 4;
                px[y * 8 + x] = n === cfg.transp ? -1 : hi | n;
            }
        }
        return px;
    }

    // Paleta → RGBA; v textovém režimu je průhledná barva palety rovná NR $14 (renderer.cpp:683)
    function colourLut(pal, cfg) {
        const lut = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            const c = pal[i] | 0;
            lut[i] = cfg.text && (c >> 1) === cfg.nr14 ? 0 : rgba32(c);
        }
        return lut;
    }

    // Celá mapa → Uint32Array (cols·8 × 256)
    function renderMap(mem, cfg, mb, db, lut, out) {
        const w = cfg.cols * 8;
        const buf = out || new Uint32Array(w * 256);
        const px = new Int16Array(64);
        for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < cfg.cols; col++) {
                const e = mapEntry(mem, cfg, mb, col, row);
                tilePixels(mem, cfg, db, e.tile, e.attr, px);
                let o = row * 8 * w + col * 8;
                for (let y = 0; y < 8; y++, o += w) {
                    for (let x = 0; x < 8; x++) {
                        const i = px[y * 8 + x];
                        buf[o + x] = i < 0 ? 0 : lut[i];
                    }
                }
            }
        }
        return buf;
    }

    // Sada definic: count dlaždic po GRID_COLS na řádek, mezera 1 px; atribut jen s offsetem palety
    function renderDefs(mem, cfg, db, lut, count, palOff, out) {
        const w = GRID_COLS * CELL - 1;
        const h = Math.ceil(count / GRID_COLS) * CELL - 1;
        const buf = out || new Uint32Array(w * h);
        buf.fill(0);
        const attr = cfg.text ? (palOff & 0x7f) << 1 : (palOff & 15) << 4;
        const px = new Int16Array(64);
        for (let t = 0; t < count; t++) {
            tilePixels(mem, cfg, db, t, attr, px);
            let o = Math.floor(t / GRID_COLS) * CELL * w + (t % GRID_COLS) * CELL;
            for (let y = 0; y < 8; y++, o += w) {
                for (let x = 0; x < 8; x++) {
                    const i = px[y * 8 + x];
                    buf[o + x] = i < 0 ? 0 : lut[i];
                }
            }
        }
        return { buf, w, h };
    }

    // Viditelná část v pixelech mapy: obrazovka 320 × 256 (40 sloupců) nebo 640 × 256 (80 sloupců),
    // ořez X1·2 … X2·2+1 v prostoru 320 (tilemap.cpp:395-396), posun o scroll se zalomením
    // (X mod 320/640, Y & 255 – tilemap.cpp:431, :524)
    function visibleRects(cfg, sx, sy, clip) {
        const k = cfg.cols === 80 ? 2 : 1;      // pixelů mapy na pixel obrazovky 320
        const mw = cfg.cols * 8;
        let x1 = 0;
        let x2 = 319;
        let y1 = 0;
        let y2 = 255;
        if (clip) {
            x1 = clip.x1 * 2;
            x2 = Math.min(319, clip.x2 * 2 + 1);
            y1 = clip.y1;
            y2 = clip.y2;
        }
        if (x1 > x2 || y1 > y2) return { rects: [], origin: null };
        const ox = sx % mw;
        const oy = sy & 0xff;
        const spans = (a, b, o, size) => {
            const s = (a + o) % size;
            const e = s + (b - a);
            return e < size ? [[s, e]] : [[s, size - 1], [0, e - size]];
        };
        const rects = [];
        for (const [xa, xb] of spans(x1 * k, x2 * k + k - 1, ox, mw)) {
            for (const [ya, yb] of spans(y1, y2, oy, 256)) rects.push({ x: xa, y: ya, w: xb - xa + 1, h: yb - ya + 1 });
        }
        return { rects, origin: { x: ox, y: oy } };
    }

    // Přeložený text s uzly DOM na místě {0}, {1} … (pole dětí pro api.el)
    function fill(key, ...args) {
        return api.t(key).split(/\{(\d+)\}/).map((p, i) => (i & 1 ? args[+p] : p));
    }

    // ---- stav pohledu
    let api = null;
    let zoom = 2;
    let defZoom = 3;
    let palOff = 0;
    let showVis = true;
    let busy = null;
    let last = null;    // {cfg, mb, db, mem, sx, sy, vis, lut, count}
    const els = {};
    const map = { ctx: null, img: null };
    const defs = { ctx: null, img: null };

    function mount(el, a) {
        api = a;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        els.zoom = api.el('select', { title: api.t('tilemap.mapZoom'), onChange: () => {
            zoom = +els.zoom.value;
            layout();
        } }, api.el('option', { value: '1' }, '1×'), api.el('option', { value: '2' }, '2×'));
        els.zoom.value = String(zoom);
        els.vis = api.el('input', { type: 'checkbox', onChange: () => {
            showVis = els.vis.checked;
            layout();
        } });
        els.vis.checked = showVis;
        el.appendChild(api.el('div', { class: 'toolbar' }, els.zoom,
            api.el('label', { title: api.t('tilemap.visibleTip') }, els.vis, ' ' + api.t('tilemap.visible'))));

        els.info = api.el('div', { class: 'info mono' });
        els.map = api.canvas(320, 256, zoom);
        els.map.classList.add('checker');
        els.overlay = api.el('div');
        els.stage = api.el('div', { class: 'stage' }, els.map, els.overlay);
        els.hover = api.el('div', { class: 'hover mono muted' });

        els.pal = api.el('input', { type: 'number', min: '0', max: '15', value: '0', title: api.t('tilemap.palOffTip'), onChange: () => {
            palOff = Math.max(0, Math.min(+els.pal.max, +els.pal.value | 0));
            redrawDefs();
        } });
        els.defZoom = api.el('select', { title: api.t('tilemap.defZoom'), onChange: () => {
            defZoom = +els.defZoom.value;
            layoutDefs();
        } }, ['2', '3', '4'].map((v) => api.el('option', { value: v }, v + '×')));
        els.defZoom.value = String(defZoom);
        els.defsTitle = api.el('h4', null, api.t('tilemap.defsTitle'));
        els.defs = api.canvas(GRID_COLS * CELL - 1, 16 * CELL - 1, defZoom);
        els.defs.classList.add('checker');
        els.defMark = api.el('div', { class: 'mark' });
        els.defMark.style.display = 'none';
        els.defStage = api.el('div', { class: 'stage' }, els.defs, els.defMark);
        els.defHover = api.el('div', { class: 'hover mono muted' });

        el.appendChild(els.info);
        el.appendChild(els.stage);
        el.appendChild(els.hover);
        el.appendChild(els.defsTitle);
        el.appendChild(api.el('div', { class: 'defs-bar' }, api.el('label', null, api.t('tilemap.palOff') + ' ', els.pal), els.defZoom));
        el.appendChild(els.defStage);
        el.appendChild(els.defHover);

        els.map.addEventListener('mousemove', onMapHover);
        els.map.addEventListener('mouseleave', () => {
            els.hover.textContent = '';
            els.defMark.style.display = 'none';
            api.highlight(null);
        });
        els.defs.addEventListener('mousemove', onDefHover);
        els.defs.addEventListener('mouseleave', () => {
            els.defHover.textContent = '';
        });
        if (!api.state.attached) els.info.textContent = api.t('tilemap.noSession');
    }

    function box(cls, r, s) {
        const d = api.el('div', { class: cls });
        d.style.left = r.x * s + 'px';
        d.style.top = r.y * s + 'px';
        if (r.w !== undefined) {
            d.style.width = r.w * s + 'px';
            d.style.height = r.h * s + 'px';
        }
        return d;
    }

    // CSS pixelů na pixel mapy (prostor 320 × 256 · zoom; 80 sloupců má poloviční pixely)
    function mapScale() {
        return last && last.cfg.cols === 80 ? zoom / 2 : zoom;
    }

    function layout() {
        if (!last) return;
        const s = mapScale();
        els.map.style.width = last.cfg.cols * 8 * s + 'px';
        els.map.style.height = 256 * s + 'px';
        const boxes = [];
        if (showVis && last.vis) {
            for (const r of last.vis.rects) boxes.push(box('vis', r, s));
            if (last.vis.origin) {
                const o = box('origin', last.vis.origin, s);
                o.title = api.t('tilemap.origin');
                boxes.push(o);
            }
        }
        els.overlay.replaceChildren(...boxes);
    }

    function layoutDefs() {
        if (!last) return;
        els.defs.style.width = els.defs.width * defZoom + 'px';
        els.defs.style.height = els.defs.height * defZoom + 'px';
    }

    function redrawDefs() {
        if (!last) return;
        const r = renderDefs(last.mem, last.cfg, last.db, last.lut, last.count, palOff);
        if (!defs.img || defs.img.width !== r.w || defs.img.height !== r.h) {
            els.defs.width = r.w;
            els.defs.height = r.h;
            defs.ctx = els.defs.getContext('2d');
            defs.img = defs.ctx.createImageData(r.w, r.h);
        }
        new Uint32Array(defs.img.data.buffer).set(r.buf);
        defs.ctx.putImageData(defs.img, 0, 0);
        layoutDefs();
    }

    function pos(canvas, e, w, h) {
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return {
            x: Math.min(w - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * w))),
            y: Math.min(h - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * h))),
        };
    }

    function where(b, off) {
        // banka 5 je v CPU obvykle na $4000–$7FFF
        return b.bank7 ? api.t('tilemap.bank7', api.hex(off & 0x1fff, 4)) : api.t('tilemap.bank5', api.hex(off & 0x3fff, 4), api.hex(0x4000 + (off & 0x3fff), 4));
    }

    function attrText(cfg, attr) {
        const a = attrInfo(cfg, attr);
        const parts = [api.t('tilemap.attrPal', a.pal, cfg.text ? 2 : 16)];
        if (!cfg.text) {
            if (a.xm) parts.push(api.t('tilemap.mirrorX'));
            if (a.ym) parts.push(api.t('tilemap.mirrorY'));
            if (a.rot) parts.push(api.t('tilemap.rotate'));
        }
        if (cfg.t512) parts.push(api.t('tilemap.bit8'));
        else parts.push(api.t(a.bit0 ? 'tilemap.ulaOverTile' : 'tilemap.tileOverUla'));
        return parts.join(', ');
    }

    function onMapHover(e) {
        if (!last) return;
        const { cfg, mb, db } = last;
        const p = pos(els.map, e, cfg.cols * 8, 256);
        if (!p) return;
        const col = p.x >> 3;
        const row = p.y >> 3;
        const en = mapEntry(last.mem, cfg, mb, col, row);
        const defAddr = db.off + en.tile * (cfg.text ? 8 : 32);
        els.hover.textContent = api.t('tilemap.hoverTile', col, row, en.tile, api.hex(en.tile, en.tile > 255 ? 3 : 2)) +
            '  ·  ' + api.t(cfg.noAttr ? 'tilemap.hoverAttrDefault' : 'tilemap.hoverAttr', api.hex(en.attr), attrText(cfg, en.attr)) +
            '\n' + api.t('tilemap.hoverWhere', where(mb, en.addr), where(db, defAddr));
        // dlaždice v sadě definic
        if (en.tile < last.count) {
            const m = els.defMark;
            const s = defZoom;
            m.style.display = '';
            m.style.left = ((en.tile % GRID_COLS) * CELL - 1) * s + 'px';
            m.style.top = (Math.floor(en.tile / GRID_COLS) * CELL - 1) * s + 'px';
            m.style.width = 10 * s + 'px';
            m.style.height = 10 * s + 'px';
        }
        // kde je dlaždice na obrazovce (prostor 320 × 256)
        const k = cfg.cols === 80 ? 2 : 1;
        const mw = cfg.cols * 8;
        const x = (((col * 8 - last.sx) % mw) + mw) % mw;
        const y = (((row * 8 - last.sy) % 256) + 256) % 256;
        api.highlight({ x: Math.floor(x / k), y, w: 8 / k, h: 8 });
    }

    function onDefHover(e) {
        if (!last) return;
        const p = pos(els.defs, e, els.defs.width, els.defs.height);
        if (!p) return;
        const cx = Math.floor(p.x / CELL);
        const cy = Math.floor(p.y / CELL);
        const t = cy * GRID_COLS + cx;
        if (t >= last.count) {
            els.defHover.textContent = '';
            return;
        }
        const size = last.cfg.text ? 8 : 32;
        els.defHover.textContent = api.t('tilemap.hoverDef', t, api.hex(t, t > 255 ? 3 : 2), where(last.db, last.db.off + t * size), size);
    }

    function infoLine(nr, nrRes, cfg, mb, db, sx, sy) {
        const idx = (nr[0x1c] >> 6) & 3;
        const clip = nrRes.clips && nrRes.clips.tilemap;
        const clipText = clip
            ? 'X ' + api.hex(clip.x1) + '–' + api.hex(clip.x2) + ', Y ' + api.hex(clip.y1) + '–' + api.hex(clip.y2)
            : api.t('tilemap.clipPart', ['X1', 'X2', 'Y1', 'Y2'][idx], api.hex(nr[0x1b]));
        const mode = [cfg.cols + ' × 32', cfg.text ? api.t('tilemap.text1bpp') : '4 bpp', api.t('tilemap.tiles', cfg.t512 ? 512 : 256),
            cfg.noAttr ? api.t('tilemap.noAttr', api.hex(cfg.defAttr)) : api.t('tilemap.withAttr')].join(', ');
        els.info.replaceChildren(
            api.el('div', null, fill(cfg.onTop ? 'tilemap.infoModeTop' : 'tilemap.infoMode', api.el('b', null, mode), api.hex(nr[0x6b]),
                api.el('span', { class: cfg.on ? '' : 'warn' }, api.t(cfg.on ? 'tilemap.on' : 'tilemap.off')))),
            api.el('div', null, api.t('tilemap.infoAddr', api.hex(nr[0x6e]), where(mb, mb.off), api.hex(nr[0x6f]), where(db, db.off))),
            api.el('div', null, api.t('tilemap.infoScroll', sx, sy, clipText)),
            api.el('div', null, api.t(cfg.pal2 ? 'tilemap.infoPalSecond' : 'tilemap.infoPalFirst',
                cfg.text ? api.t('tilemap.transpColour', api.hex(cfg.nr14)) : api.t('tilemap.transpIndex', cfg.transp))));
    }

    async function load(a) {
        const nrRes = await a.request('nextregs');
        const nr = a.bytes(nrRes.data);
        const cfg = control(nr);
        const mb = base(nr[0x6e]);
        const db = base(nr[0x6f]);
        // banka 5 = stránky 10–11 (16K), banka 7 = stránka 14 (jen dolních 8K, mmu.h:1489-1495)
        const need5 = !mb.bank7 || !db.bank7;
        const need7 = mb.bank7 || db.bank7;
        const [pals, b5, b7] = await Promise.all([
            a.request('palettes'),
            need5 ? a.request('readMemory', { page: 10, addr: 0, length: 0x4000 }).then((r) => r.data).catch(() => null) : null,
            need7 ? a.request('readMemory', { page: 14, addr: 0, length: 0x2000 }).then((r) => r.data) : null,
        ]);
        const mem = { b5: new Uint8Array(0x4000), b7: new Uint8Array(0x2000) };
        if (b7) mem.b7.set(a.bytes(b7).subarray(0, 0x2000));
        if (need5) {
            if (b5 !== null) mem.b5.set(a.bytes(b5).subarray(0, 0x4000));
            else {
                // starší server čte jen v rámci jedné 8K stránky
                const [lo, hi] = await Promise.all([10, 11].map((page) => a.request('readMemory', { page, addr: 0, length: 0x2000 })));
                mem.b5.set(a.bytes(lo.data).subarray(0, 0x2000), 0);
                mem.b5.set(a.bytes(hi.data).subarray(0, 0x2000), 0x2000);
            }
        }
        const pal = (pals.banks && pals.banks[cfg.pal2 ? 'tilemap1' : 'tilemap0']) || [];
        const lut = colourLut(pal, cfg);
        const sx = ((nr[0x2f] & 3) << 8) | nr[0x30];
        const sy = nr[0x31];
        const w = cfg.cols * 8;

        if (!map.img || map.img.width !== w) {
            els.map.width = w;
            els.map.height = 256;
            map.ctx = els.map.getContext('2d');
            map.img = map.ctx.createImageData(w, 256);
        }
        renderMap(mem, cfg, mb, db, lut, new Uint32Array(map.img.data.buffer));
        map.ctx.putImageData(map.img, 0, 0);

        const clip = nrRes.clips && nrRes.clips.tilemap;
        const count = cfg.t512 ? 512 : 256;
        last = { cfg, mb, db, mem, sx, sy, lut, count, vis: visibleRects(cfg, sx, sy, clip || null) };
        els.pal.max = cfg.text ? '127' : '15';
        if (palOff > +els.pal.max) {
            palOff = +els.pal.max;
            els.pal.value = String(palOff);
        }
        els.defsTitle.textContent = api.t('tilemap.defsTitleInfo', count, cfg.text ? 8 : 32);
        infoLine(nr, nrRes, cfg, mb, db, sx, sy);
        layout();
        redrawDefs();
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.info.textContent = api.t('tilemap.noSession');
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

    NextView.register({ id: ID, title: NextView.t('tilemap.title'), order: 60, mount, refresh });
})();
