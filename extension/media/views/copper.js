// Pohled Copper: výpis programu (1024 instrukcí) s dekódováním, aktuální PC, režim; najetí na WAIT
// zvýrazní jeho řádek na obrazovce. Kódování a počítání řádků podle JNEXT peripheral/copper.cpp
// a core/emulator.cpp (cvc = řádek od začátku zobrazení + NR $64).
(function () {
    const STYLE = `
#view-copper .cu-scroll { position: relative; max-height: calc(100vh - 110px); overflow: auto; }
#view-copper .cu-table tr.pc td { background: var(--vscode-editor-lineHighlightBackground, var(--vscode-list-inactiveSelectionBackground)); }
#view-copper .cu-table tr.pc td:first-child { box-shadow: inset 3px 0 0 var(--vscode-debugIcon-pauseForeground, var(--vscode-focusBorder)); }
#view-copper .cu-table tr.wait:hover td { background: var(--vscode-list-hoverBackground); cursor: crosshair; }
#view-copper .op-WAIT { color: var(--vscode-debugTokenExpression-number, var(--vscode-textLink-foreground)); }
#view-copper .op-MOVE { color: var(--vscode-debugTokenExpression-name, var(--vscode-foreground)); }
#view-copper .op-NOP { color: var(--vscode-descriptionForeground); }
#view-copper .op-HALT { color: var(--vscode-errorForeground); }
#view-copper .cu-table thead th { position: sticky; top: 0; background: var(--vscode-editor-background); }
#view-copper .cu-state b { font-weight: normal; color: var(--vscode-textLink-foreground); }
`;
    const t = NextView.t;
    const MODES = [t('copper.mode.stop'), t('copper.mode.start'), t('copper.mode.resume'), t('copper.mode.frameReset')];
    const SHOW = [['all', t('copper.show.all')], ['trim', t('copper.show.trim')], ['halt', t('copper.show.halt')]];

    let api = null;
    let rows = [];           // {tr, word, op, args, scr}
    let words = null;        // Uint16Array programu z minulého obnovení
    let geo = null;          // geometrie snímku pro přepočet řádků
    let pc = -1;
    let show = 'all';
    let follow = true;
    let scroller = null;
    let stateEl = null;

    // ---- dekódování (copper.cpp:67–91)

    /** Instrukce Copperu → {op, reg?, val?, line?, hpos?}. */
    function decode(w) {
        if (w & 0x8000) {
            const line = w & 0x1FF;
            const hpos = (w >> 9) & 0x3F;
            return { op: line === 511 ? 'HALT' : 'WAIT', line, hpos };
        }
        const reg = (w >> 8) & 0x7F;
        return { op: reg === 0 ? 'NOP' : 'MOVE', reg, val: w & 0xFF };
    }

    /** Práh vodorovné pozice WAIT v pixelech ULA (hc ≥ hpos·8 + 12, 9 bitů s přetečením). */
    function hThreshold(hpos) {
        return ((hpos << 3) + 12) & 0x1FF;
    }

    /**
     * Geometrie snímku z NR $03 (časování) a $05 (60 Hz) – timing.cpp init_timing:
     * počet řádků a první řádek zobrazení (c_min_vactive).
     */
    function geometry(nr) {
        if (!nr) return { lines: 311, vactive: 64, guess: true };
        const timing = (nr[0x03] >> 4) & 7;
        if (timing & 4) return { lines: 320, vactive: 80 };            // Pentagon
        if (nr[0x05] & 4) return { lines: 264, vactive: 40 };          // 60 Hz
        return { lines: timing <= 1 ? 312 : 311, vactive: 64 };        // 48K / 128K, +3, Next
    }

    /**
     * Řádek Copperu → y v prostoru 320 × 256 (horní okraj 32 řádků), nebo null mimo obraz.
     * cvc = (raw − c_min_vactive + offset) mod lines; řádek obrazu = raw − (c_min_vactive − 32).
     */
    function lineToY(line, offset, g) {
        if (line >= g.lines) return null;
        let d = (((line - offset) % g.lines) + g.lines) % g.lines;
        if (d >= g.lines - g.vactive) d -= g.lines;   // řádky před začátkem zobrazení
        const y = d + 32;
        return y >= 0 && y < 256 ? y : null;
    }

    function h(v, digits) {
        return v.toString(16).toUpperCase().padStart(digits, '0');
    }

    function regName(n) {
        const names = window.NextRegNames;   // načte se po copper.js, proto až tady
        return (names && names.name(n)) || '';
    }

    /** Přeložená šablona s {0}, {1} … → kousky pro api.el (parametry mohou být i prvky). */
    function parts(key, ...args) {
        return t(key).split(/\{(\d+)\}/).map((s, i) => (i % 2 ? args[Number(s)] : s)).filter((s) => s !== '');
    }

    function describe(w) {
        const d = decode(w);
        if (d.op === 'MOVE') {
            const name = regName(d.reg);
            let title = '';
            const names = window.NextRegNames;
            if (names) title = names.decode(d.reg, d.val).map((p) => p.bits + ' ' + p.label + ': ' + p.text).join('\n');
            return { d, args: 'NR $' + h(d.reg, 2) + (name ? ' ' + name : '') + ' ← $' + h(d.val, 2), title };
        }
        if (d.op === 'NOP') return { d, args: d.val ? t('copper.nopMove') : '', title: '' };
        if (d.op === 'HALT') return { d, args: '', title: t('copper.haltTitle') };
        const hc = hThreshold(d.hpos);
        let title = d.hpos === 63 ? t('copper.waitTitleWrap', d.line, hc) : t('copper.waitTitle', d.line, hc);
        if (geo && d.line >= geo.lines) title += '\n' + t('copper.waitNoLine');
        return { d, args: t('copper.waitArgs', d.line, d.hpos), title };
    }

    // ---- obraz: sloupec „Obraz“ a zvýraznění

    function screenText(w) {
        const d = decode(w);
        if (d.op !== 'WAIT' || !geo) return '';
        if (d.line >= geo.lines) return t('copper.never', geo.lines);
        const y = lineToY(d.line, geo.offset, geo);
        return y === null ? t('copper.offscreen') : 'y ' + y;
    }

    let hlY = null;   // naposledy poslané zvýraznění (ať se neposílá při každém pohybu myši)

    function setHighlight(y) {
        if (y === hlY) return;
        hlY = y;
        api.highlight(y === null ? null : { x: 0, y, w: 320, h: 1 });
    }

    function onHover(ev) {
        const tr = ev.target.closest('tr');
        const i = tr ? Number(tr.dataset.i) : -1;
        if (!(i >= 0) || !words || !geo) return;
        const d = decode(words[i]);
        setHighlight(d.op === 'WAIT' ? lineToY(d.line, geo.offset, geo) : null);
    }

    // ---- stavba a obnovení

    function mount(el, a) {
        api = a;
        el.appendChild(api.el('style', null, STYLE));
        stateEl = api.el('span', { class: 'cu-state' }, 'Copper: —');
        const sel = api.el('select', { title: t('copper.showTitle') });
        for (const [v, text] of SHOW) sel.appendChild(api.el('option', { value: v }, text));
        sel.addEventListener('change', () => {
            show = sel.value;
            applyShow();
        });
        const fol = api.el('input', { type: 'checkbox' });
        fol.checked = follow;
        fol.addEventListener('change', () => {
            follow = fol.checked;
            if (follow) scrollToPc();
        });
        el.appendChild(api.el('div', { class: 'toolbar' }, stateEl, sel, api.el('label', null, fol, ' ' + t('copper.followPc'))));

        const tbody = api.el('tbody');
        rows = [];
        for (let i = 0; i < 1024; i++) {
            const r = {
                word: api.el('td', { class: 'mono' }, ''),
                op: api.el('td', { class: 'mono' }, ''),
                args: api.el('td', { class: 'mono' }, ''),
                scr: api.el('td', { class: 'muted' }, ''),
            };
            r.tr = api.el('tr', { 'data-i': i }, api.el('td', { class: 'mono muted' }, h(i, 3)), r.word, r.op, r.args, r.scr);
            rows.push(r);
            tbody.appendChild(r.tr);
        }
        tbody.addEventListener('mouseover', onHover);
        tbody.addEventListener('mouseleave', () => setHighlight(null));
        scroller = api.el('div', { class: 'cu-scroll' }, api.el('table', { class: 'table cu-table' },
            api.el('thead', null, api.el('tr', null,
                api.el('th', null, t('copper.col.index')), api.el('th', null, t('copper.col.word')), api.el('th', null, t('copper.col.instruction')),
                api.el('th', null, t('copper.col.operands')),
                api.el('th', { title: t('copper.col.screenTitle') }, t('copper.col.screen')))),
            tbody));
        el.appendChild(scroller);
    }

    function updateRow(i, w) {
        const r = rows[i];
        const x = describe(w);
        r.word.textContent = '$' + h(w, 4);
        r.op.textContent = x.d.op;
        r.op.className = 'mono op-' + x.d.op;
        r.args.textContent = x.args;
        r.args.title = x.title;
        r.scr.textContent = screenText(w);
        r.tr.classList.toggle('wait', x.d.op === 'WAIT');
    }

    /** Skrytí řádků podle volby; řádek s PC zůstává vždy vidět. */
    function applyShow() {
        let last = 1023;
        if (words && show === 'trim') {
            while (last > 0 && decode(words[last]).op === 'NOP') last--;
        } else if (words && show === 'halt') {
            last = words.findIndex((w) => decode(w).op === 'HALT');
            if (last < 0) last = 1023;
        }
        for (let i = 0; i < 1024; i++) {
            const hide = i > last && i !== pc;
            if (rows[i].tr.hidden !== hide) rows[i].tr.hidden = hide;
        }
    }

    function scrollToPc() {
        if (pc < 0 || !scroller) return;
        const tr = rows[pc].tr;
        const top = tr.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const view = scroller.clientHeight;
        if (top < scroller.scrollTop + 20 || top > scroller.scrollTop + view - 40) {
            scroller.scrollTop = Math.max(0, top - view / 2);
        }
    }

    async function refresh(a) {
        api = a;
        const [cu, nr] = await Promise.all([
            api.request('copper'),
            api.request('nextregs').catch(() => null),   // jen pro posun řádků a geometrii
        ]);
        const nrData = nr ? api.bytes(nr.data) : null;
        const g = geometry(nrData);
        g.offset = nrData ? nrData[0x64] : 0;
        const geoChanged = !geo || geo.lines !== g.lines || geo.vactive !== g.vactive || geo.offset !== g.offset;
        geo = g;

        const b = api.bytes(cu.program);
        const w = new Uint16Array(1024);
        for (let i = 0; i < 1024 && 2 * i + 1 < b.length; i++) w[i] = b[2 * i] | (b[2 * i + 1] << 8);
        const first = !words;
        for (let i = 0; i < 1024; i++) {
            if (first || geoChanged || w[i] !== words[i]) updateRow(i, w[i]);
        }
        words = w;

        const newPc = cu.pc & 0x3FF;
        if (newPc !== pc) {
            if (pc >= 0) rows[pc].tr.classList.remove('pc');
            rows[newPc].tr.classList.add('pc');
        }
        const moved = newPc !== pc;
        pc = newPc;
        applyShow();
        if (follow && (moved || first)) scrollToPc();

        const mode = cu.mode & 3;
        stateEl.textContent = '';
        stateEl.appendChild(api.el('span', null,
            parts('copper.state.pc', api.el('b', { class: 'mono' }, '$' + h(pc, 3))), ' · ',
            cu.running ? t('copper.state.running') : t('copper.state.stopped'), ' · ',
            parts('copper.state.mode', api.el('b', { title: t('copper.state.modeTitle', mode.toString(2).padStart(2, '0')) }, MODES[mode])),
            ' · ', parts('copper.state.offset', api.el('b', { class: 'mono' }, String(g.offset))),
            ' · ', g.guess ? t('copper.state.geometryGuess') : t('copper.state.lines', g.lines)));
    }

    NextView.register({ id: 'copper', title: 'Copper', order: 70, mount, refresh });
})();
