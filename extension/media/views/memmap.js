// Pohled „Mapa paměti“: 224 fyzických 8K stránek RAM Nextu – obsazenost (`pageUsage`, nenulové bajty)
// jako sytost barvy, vyznačení stránek v MMU0–7 (`mmu`), kódu ze SLD (`symbols.codePages`), bank 5/7
// (ULA, stínová ULA, tilemapa), Layer 2 (NR $12/$13, velikost podle NR $70) a ROM (`pageUsage.rom`).
// Klik na stránku ji otevře v pohledu Paměť (událost `mbx-show-memory`, memory.js).
(function () {
    'use strict';

    const ID = 'memmap';
    const PAGES = 224;
    const PAGE = 0x2000;
    const COLS = 16;

    const CSS = `
#view-memmap .mm-grid { display: grid; grid-template-columns: 4ch repeat(${COLS}, minmax(30px, 1fr)); gap: 2px; max-width: 900px; }
#view-memmap .mm-head { color: var(--vscode-descriptionForeground); text-align: center; font-size: 0.85em; align-self: center; }
#view-memmap .mm-cell { position: relative; height: 30px; box-sizing: border-box; cursor: pointer; font-size: 0.85em;
    border: 1px solid var(--vscode-panel-border); padding: 1px 2px; line-height: 1.2; overflow: hidden; }
#view-memmap .mm-cell:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#view-memmap .mm-cell.mmu { border: 2px solid var(--vscode-focusBorder); padding: 0 1px; }
#view-memmap .mm-cell .mm-slot { position: absolute; right: 2px; top: 1px; font-weight: bold; color: var(--vscode-focusBorder); }
#view-memmap .mm-cell .mm-num { color: var(--vscode-foreground); }
#view-memmap .mm-cell.empty .mm-num { color: var(--vscode-descriptionForeground); }
#view-memmap .mm-marks { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; display: flex; }
#view-memmap .mm-marks span, #view-memmap .mm-legend .sw { flex: 1; }
#view-memmap .mk-code { background: var(--vscode-charts-green); }
#view-memmap .mk-bank5, #view-memmap .mk-bank7 { background: var(--vscode-charts-purple); }
#view-memmap .mk-tilemap { background: var(--vscode-charts-yellow); }
#view-memmap .mk-layer2 { background: var(--vscode-charts-red); }
#view-memmap .mk-layer2s { background: repeating-linear-gradient(90deg, var(--vscode-charts-red) 0 3px, transparent 3px 5px); }
#view-memmap .mk-rom { background: var(--vscode-charts-orange); }
#view-memmap .mm-legend { margin: 8px 0 4px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
#view-memmap .mm-legend .sw { display: inline-block; width: 14px; height: 10px; margin-right: 4px; vertical-align: middle;
    border: 1px solid var(--vscode-panel-border); }
#view-memmap .mm-legend .sw.mmu { border: 2px solid var(--vscode-focusBorder); }
#view-memmap .mm-sum { margin-bottom: 6px; }
#view-memmap .mm-hover { min-height: 2.8em; margin-top: 6px; white-space: pre-wrap; }
#view-memmap .mm-err { color: var(--vscode-errorForeground); }
`;

    const t = NextView.t;
    const MARKS = ['code', 'bank5', 'bank7', 'tilemap', 'layer2', 'layer2s', 'rom'];

    // ---- čisté funkce (testovatelné bez DOM)

    function h2(v) {
        return (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
    }

    /** Obsazenost 0–1 z počtu nenulových bajtů stránky. */
    function occupancy(nonzero) {
        const n = Number(nonzero) || 0;
        return Math.max(0, Math.min(1, n / PAGE));
    }

    /** Sytost barvy v % pro obsazenost: prázdná 0, jinak 12–80 (i jediný bajt je vidět). */
    function shade(occ) {
        return occ <= 0 ? 0 : Math.round(12 + occ * 68);
    }

    /** Stránka → seznam slotů MMU, které ji mají namapovanou (ROM sloty s NR $FF se přeskočí). */
    function mmuPages(slots) {
        const m = new Map();
        (slots || []).forEach((s, i) => {
            if (!s || s.nr === 0xff) return;
            const p = typeof s.page === 'number' ? s.page : s.nr;
            if (typeof p !== 'number' || p < 0 || p >= PAGES) return;
            if (!m.has(p)) m.set(p, []);
            m.get(p).push(i);
        });
        return m;
    }

    /**
     * Layer 2: první stránka = 16K banka (NR $12 aktivní, NR $13 stínová, b6:0) × 2 (layer2.h:44-56);
     * velikost podle NR $70 b5:4: 0 = 256 × 192 (48K, 6 stránek), 1–3 = 320/640 × 256 (80K, 10 stránek)
     * (layer2.cpp:479-484).
     */
    function layer2Pages(nr) {
        const mode = (nr[0x70] >> 4) & 3;
        const n = mode === 0 ? 6 : 10;
        const range = (bank) => {
            const out = [];
            for (let i = 0; i < n; i++) if (bank * 2 + i < PAGES) out.push(bank * 2 + i);
            return out;
        };
        return { mode, active: range(nr[0x12] & 0x7f), shadow: range(nr[0x13] & 0x7f), on: (nr[0x69] & 0x80) !== 0 };
    }

    /**
     * Tilemapa (když NR $6B b7): mapa NR $6E, definice NR $6F – b7 banka 7 / 5, b5:0 posun × 256 B
     * (tilemap.cpp:241-251) → stránka (banka × 2) + posun ≥ $2000.
     */
    function tilemapPages(nr) {
        if (!(nr[0x6b] & 0x80)) return [];
        const pg = (r) => ((r & 0x80) ? 14 : 10) + ((r & 0x3f) >> 5);
        const a = pg(nr[0x6e]);
        const b = pg(nr[0x6f]);
        return a === b ? [a] : [a, b];
    }

    /** Návěští v každé stránce: Map stránka → {first: {name, addr}, count}. */
    function labelsByPage(labels) {
        const m = new Map();
        for (const l of labels || []) {
            if (!l || typeof l.page !== 'number' || l.page < 0 || l.page >= PAGES || typeof l.addr !== 'number') continue;
            const e = m.get(l.page);
            if (!e) m.set(l.page, { first: l, count: 1 });
            else {
                e.count++;
                if ((l.addr & (PAGE - 1)) < (e.first.addr & (PAGE - 1))) e.first = l;
            }
        }
        return m;
    }

    /** Všechno o stránkách z odpovědí serveru (chybějící odpověď = null). */
    function analyse(usage, mmu, sym, nrData) {
        const nonzero = usage && Array.isArray(usage.nonzero) ? usage.nonzero : null;
        const rom = new Set(usage && Array.isArray(usage.rom) ? usage.rom : []);
        const inMmu = mmuPages(mmu && mmu.slots);
        const code = (sym && sym.codePages) || {};
        const labels = labelsByPage(sym && sym.labels);
        const l2 = nrData ? layer2Pages(nrData) : null;
        const tm = nrData ? tilemapPages(nrData) : [];
        const pages = [];
        let used = 0;
        let codeCount = 0;
        for (let p = 0; p < PAGES; p++) {
            const nz = nonzero ? Number(nonzero[p]) || 0 : null;
            if (nz) used++;
            const c = Number(code[p] || code[String(p)]) || 0;
            if (c) codeCount++;
            const marks = new Set();
            if (c) marks.add('code');
            if (p === 10 || p === 11) marks.add('bank5');
            if (p === 14 || p === 15) marks.add('bank7');
            if (tm.includes(p)) marks.add('tilemap');
            if (l2 && l2.active.includes(p)) marks.add('layer2');
            if (l2 && l2.shadow.includes(p) && !l2.active.includes(p)) marks.add('layer2s');
            if (rom.has(p)) marks.add('rom');
            pages.push({ page: p, nonzero: nz, occ: nz === null ? null : occupancy(nz), slots: inMmu.get(p) || [], code: c, marks, labels: labels.get(p) || null });
        }
        return { pages, used, codeCount, hasUsage: !!nonzero, l2, mmu: inMmu };
    }

    // ---- stav pohledu
    let api = null;
    let last = null;
    let hoverPage = -1;
    const cells = [];
    const els = {};

    function mount(el, a) {
        api = a;
        el.appendChild(api.el('style', null, CSS));
        els.sum = api.el('div', { class: 'mm-sum' });
        el.appendChild(els.sum);
        const grid = api.el('div', { class: 'mm-grid mono' });
        grid.appendChild(api.el('div', { class: 'mm-head' }, ''));
        for (let c = 0; c < COLS; c++) grid.appendChild(api.el('div', { class: 'mm-head' }, '+' + c.toString(16).toUpperCase()));
        for (let p = 0; p < PAGES; p++) {
            if (p % COLS === 0) {
                grid.appendChild(api.el('div', { class: 'mm-head', title: t('memmap.rowTip', p >> 1, (p + COLS - 1) >> 1) }, h2(p)));
            }
            const num = api.el('span', { class: 'mm-num' }, h2(p));
            const slot = api.el('span', { class: 'mm-slot' });
            const marks = api.el('div', { class: 'mm-marks' });
            const cell = api.el('div', { class: 'mm-cell empty' }, num, slot, marks);
            cell.addEventListener('mouseenter', () => hover(p));
            cell.addEventListener('click', () => open(p));
            cells.push({ cell, slot, marks, key: '' });
            grid.appendChild(cell);
        }
        grid.addEventListener('mouseleave', () => hover(-1));
        el.appendChild(grid);

        const sw = (cls, text) => api.el('span', null, api.el('span', { class: 'sw ' + cls }), text);
        const occ = (pct) => {
            const s = api.el('span', { class: 'sw' });
            s.style.background = colour(pct);
            return s;
        };
        els.legend = api.el('div', { class: 'mm-legend muted' },
            api.el('span', null, occ(0), occ(shade(0.25)), occ(shade(0.5)), occ(shade(1)), t('memmap.legendUsage')),
            sw('mmu', t('memmap.legendMmu')),
            sw('mk-code', t('memmap.legendCode')),
            sw('mk-bank5', t('memmap.legendBanks')),
            sw('mk-tilemap', t('memmap.legendTilemap')),
            sw('mk-layer2', 'Layer 2'),
            sw('mk-layer2s', t('memmap.legendLayer2Shadow')),
            sw('mk-rom', 'ROM'));
        el.appendChild(els.legend);
        els.hover = api.el('div', { class: 'mm-hover mono' });
        el.appendChild(els.hover);
        els.sum.textContent = api.state.attached ? '' : t('memmap.noSession');
    }

    function colour(pct) {
        return pct <= 0 ? 'transparent' : 'color-mix(in srgb, var(--vscode-charts-blue) ' + pct + '%, transparent)';
    }

    function fmt(n) {
        try {
            return Number(n).toLocaleString(api.lang || NextView.lang);
        } catch (e) {
            return String(n);
        }
    }

    /** Popis stránky (řádky textu) pro najetí myší a title. */
    function describe(info, l2) {
        const p = info.page;
        const lines = [];
        const head = [t('memmap.page', '$' + h2(p), p), t('memmap.bank', p >> 1, p & 1 ? t('memmap.upperHalf') : t('memmap.lowerHalf'))];
        if (info.nonzero !== null) head.push(t('memmap.usage', fmt(info.nonzero), fmt(PAGE), Math.round(info.occ * 100)));
        lines.push(head.join('  ·  '));
        const what = [];
        for (const s of info.slots) what.push('MMU' + s + ' ($' + (s * PAGE).toString(16).toUpperCase().padStart(4, '0') + ')');
        if (p === 10) what.push(t('memmap.ula'));
        if (p === 11) what.push(t('memmap.bank5'));
        if (p === 14) what.push(t('memmap.ulaShadow'));
        if (p === 15) what.push(t('memmap.bank7'));
        if (info.marks.has('tilemap')) what.push(t('memmap.tilemap'));
        if (info.marks.has('layer2')) what.push(t(l2 && l2.on ? 'memmap.layer2' : 'memmap.layer2Off'));
        if (info.marks.has('layer2s')) what.push(t('memmap.layer2Shadow'));
        if (info.marks.has('rom')) what.push('ROM');
        if (info.code) what.push(t('memmap.code', info.code));
        if (info.labels) {
            const f = info.labels.first;
            const a = '$' + ((f.addr & 0xffff).toString(16).toUpperCase().padStart(4, '0'));
            what.push(info.labels.count > 1 ? t('memmap.labelMore', f.name, a, info.labels.count - 1) : t('memmap.label', f.name, a));
        }
        if (!what.length) what.push(info.nonzero === 0 ? t('memmap.empty') : t('memmap.nothing'));
        lines.push(what.join('  ·  '));
        return lines.join('\n');
    }

    function hover(p) {
        hoverPage = p;
        if (!els.hover) return;
        if (p < 0 || !last) {
            els.hover.textContent = last ? t('memmap.hoverHint') : '';
            return;
        }
        els.hover.textContent = describe(last.pages[p], last.l2);
    }

    function open(p) {
        window.dispatchEvent(new CustomEvent('mbx-show-memory', { detail: { page: p } }));
        // framework zatím přepínání záložek nemá; až bude, použije se
        if (typeof NextView.show === 'function') NextView.show('memory');
        els.hover.textContent = t('memmap.opened', '$' + h2(p), p);
    }

    function paint(res) {
        last = res;
        for (const info of res.pages) {
            const c = cells[info.page];
            const pct = info.occ === null ? 0 : shade(info.occ);
            const marks = MARKS.filter((m) => info.marks.has(m));
            const key = pct + '|' + info.slots.join(',') + '|' + marks.join(',') + '|' + info.code + '|' + info.nonzero + '|' +
                (info.labels ? info.labels.count + info.labels.first.name : '');
            c.cell.title = describe(info, res.l2);
            if (key === c.key) continue;
            c.key = key;
            c.cell.style.background = colour(pct);
            c.cell.className = 'mm-cell' + (info.slots.length ? ' mmu' : '') + (info.nonzero === 0 ? ' empty' : '');
            c.slot.textContent = info.slots.length ? 'M' + info.slots.join(',') : '';
            c.marks.replaceChildren(...marks.map((m) => api.el('span', { class: 'mk-' + m })));
        }
        const parts = [];
        parts.push(res.hasUsage ? t('memmap.summary', res.used, PAGES) : t('memmap.noUsage'));
        if (res.codeCount) parts.push(t('memmap.summaryCode', res.codeCount));
        const mm = [...res.mmu.keys()].sort((a, b) => a - b).map((p) => '$' + h2(p));
        if (mm.length) parts.push(t('memmap.summaryMmu', mm.join(' ')));
        els.sum.replaceChildren(api.el('span', { class: res.hasUsage ? '' : 'mm-err' }, parts.join('  ·  ')));
        hover(hoverPage);
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.sum.textContent = t('memmap.noSession');
            return;
        }
        let err = null;
        const keep = (p) => p.catch((e) => {
            err = err || e;
            return null;
        });
        const [usage, mmu, sym, nr] = await Promise.all([
            keep(a.request('pageUsage')), keep(a.request('mmu')), a.request('symbols').catch(() => null), keep(a.request('nextregs')),
        ]);
        if (!usage && !mmu && !nr) throw err || new Error(t('memmap.noUsage'));
        paint(analyse(usage, mmu, sym, nr && nr.data ? a.bytes(nr.data) : null));
    }

    NextView.register({
        id: ID, title: t('memmap.title'), order: 86, mount, refresh,
        // pro testy (docs/testing.md): čisté funkce bez DOM
        helpers: { occupancy, shade, mmuPages, layer2Pages, tilemapPages, labelsByPage, analyse },
    });
})();
