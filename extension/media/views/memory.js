// Pohled „Paměť“: hex prohlížeč – CPU 64K přes aktuální MMU nebo jedna fyzická 8K stránka (0–223).
// Návěští a kód ze SLD (dotaz `symbols`), ROM ze slotů MMU (NR stránka $FF), zvýraznění změn od minulého
// obnovení, vykreslují se jen viditelné řádky. Úprava bajtu dvojklikem (`writeMemory`) jen v pauze.
// Mapa paměti (memmap.js) sem posílá stránku událostí `mbx-show-memory` {detail: {page}}.
(function () {
    'use strict';

    const ID = 'memory';
    const PAGE = 0x2000;        // 8K stránka
    const PAGES = 224;          // stránky RAM Nextu (readMemory: stránka ≥ $E0 → invalid_page)
    const ROW = 16;             // bajtů na řádek
    const ROW_H = 18;           // výška řádku v px (CSS .mx-row)
    const OVERSCAN = 4;         // řádky navíc nad a pod viditelnou částí
    const FALLBACK_ROWS = 32;   // když viewport ještě nemá výšku (skrytý)
    const MAX_SUGGEST = 50;     // položek našeptávače

    const CSS = `
#view-memory .mx-view { position: relative; overflow-y: auto; height: calc(100vh - 170px); min-height: 180px;
    border: 1px solid var(--vscode-panel-border); }
#view-memory .mx-rows { position: absolute; left: 0; right: 0; top: 0; }
#view-memory .mx-row { height: ${ROW_H}px; line-height: ${ROW_H}px; white-space: pre; padding: 0 4px; }
#view-memory .mx-row.slot { box-shadow: inset 0 1px 0 var(--vscode-panel-border); }
#view-memory .mx-row span { display: inline-block; }
#view-memory .mx-a { width: 7.5ch; color: var(--vscode-descriptionForeground); padding-left: 2px; }
#view-memory .mx-a.code { background: color-mix(in srgb, var(--vscode-charts-green) 22%, transparent); }
#view-memory .mx-a.rom { background: color-mix(in srgb, var(--vscode-charts-orange) 22%, transparent); }
#view-memory .mx-l { width: 16ch; overflow: hidden; text-overflow: ellipsis; vertical-align: top;
    color: var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground)); }
#view-memory .mx-b { width: 2.6ch; text-align: center; cursor: default; }
#view-memory .mx-b.gap { margin-left: 1ch; }
#view-memory .mx-b.lbl { text-decoration: underline; text-decoration-color: var(--vscode-textLink-foreground); }
#view-memory .mx-b.chg { color: var(--vscode-editorWarning-foreground); font-weight: bold;
    background: var(--vscode-editor-findMatchHighlightBackground); }
#view-memory .mx-b.cur { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#view-memory .mx-b input { width: 2.4ch; padding: 0; border: none; font: inherit; text-align: center; }
#view-memory .mx-c { margin-left: 2ch; color: var(--vscode-descriptionForeground); }
#view-memory .mx-addr { width: 16em; }
#view-memory .mx-page { width: 4.5em; }
#view-memory .mx-info, #view-memory .mx-sel { margin-bottom: 4px; min-height: 1.4em; }
#view-memory .mx-msg { min-height: 1.4em; }
#view-memory .mx-msg.warn { color: var(--vscode-editorWarning-foreground); }
#view-memory .mx-msg.err { color: var(--vscode-errorForeground); }
#view-memory .mx-legend span.sw { display: inline-block; width: 10px; height: 10px; margin: 0 3px 0 8px; vertical-align: middle;
    border: 1px solid var(--vscode-panel-border); }
#view-memory .mx-legend .sw.code { background: color-mix(in srgb, var(--vscode-charts-green) 45%, transparent); }
#view-memory .mx-legend .sw.rom { background: color-mix(in srgb, var(--vscode-charts-orange) 45%, transparent); }
#view-memory .mx-legend .sw.chg { background: var(--vscode-editor-findMatchHighlightBackground); }
`;

    const t = NextView.t;

    // ---- čisté funkce (testovatelné bez DOM)

    function h2(v) {
        return (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
    }

    function h4(v) {
        return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    }

    /** Číslo: $hex, 0xhex, #hex, hexh, desítkové; bez předpony s písmeny a–f jako hex. Jinak null. */
    function parseNumber(s) {
        s = String(s).trim();
        let m;
        if ((m = /^(?:\$|0x|#)([0-9a-f]+)$/i.exec(s))) return parseInt(m[1], 16);
        if ((m = /^([0-9][0-9a-f]*)h$/i.exec(s))) return parseInt(m[1], 16);
        if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
        if (/^[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
        return null;
    }

    /** Bajt k zápisu: 1–2 hex číslice (volitelně $ nebo 0x). */
    function parseByte(s) {
        const m = /^(?:\$|0x)?([0-9a-f]{1,2})$/i.exec(String(s).trim());
        return m ? parseInt(m[1], 16) : null;
    }

    /** Stránka RAM ve slotu MMU, nebo -1 (ROM: NR stránka $FF, smlouva `mmu` slots [{nr, page}]). */
    function slotPage(slots, s) {
        const x = slots && slots[s];
        if (!x || x.nr === 0xff) return -1;
        return typeof x.page === 'number' ? x.page : x.nr;
    }

    function isRomSlot(slots, s) {
        const x = slots && slots[s];
        return !!x && x.nr === 0xff;
    }

    function hasPage(l) {
        return typeof l.page === 'number' && l.page >= 0;
    }

    /**
     * Návěští v prostoru pohledu: [{at, name}] seřazené podle `at` (index v zobrazených datech).
     * CPU: návěští se stránkou leží tam, kam je stránka namapovaná (každý slot s tou stránkou),
     * bez stránky na své adrese. Stránka: jen návěští s touto stránkou, posun addr & $1FFF.
     */
    function placeLabels(labels, space, page, slots) {
        const out = [];
        for (const l of labels || []) {
            if (!l || typeof l.addr !== 'number' || !l.name) continue;
            if (space === 'page') {
                if (hasPage(l) && l.page === page) out.push({ at: l.addr & (PAGE - 1), name: l.name });
                continue;
            }
            if (!hasPage(l)) {
                out.push({ at: l.addr & 0xffff, name: l.name });
                continue;
            }
            for (let s = 0; s < 8; s++) {
                if (slotPage(slots, s) === l.page) out.push({ at: s * PAGE + (l.addr & (PAGE - 1)), name: l.name });
            }
        }
        out.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return out;
    }

    /** Index posledního návěští s at ≤ i (binární hledání), nebo -1. */
    function labelBefore(placed, i) {
        let lo = 0;
        let hi = placed.length - 1;
        let r = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (placed[m].at <= i) {
                r = m;
                lo = m + 1;
            } else hi = m - 1;
        }
        return r;
    }

    /** Návěští podle jména: přesně, pak bez ohledu na velikost písmen. */
    function findLabel(labels, name) {
        const list = labels || [];
        const exact = list.find((l) => l && l.name === name);
        if (exact) return exact;
        const low = name.toLowerCase();
        return list.find((l) => l && typeof l.name === 'string' && l.name.toLowerCase() === low) || null;
    }

    /**
     * Zadání adresy → {space: 'cpu' | 'page', page?, addr} nebo null.
     * „stránka:posun“ (čísla) = fyzická stránka; číslo = adresa v aktuálním prostoru; jinak návěští.
     */
    function parseAddress(text, ctx) {
        const s = String(text || '').trim();
        if (!s) return null;
        const pm = /^([^:]+):([^:]+)$/.exec(s);
        if (pm) {
            const p = parseNumber(pm[1]);
            const a = parseNumber(pm[2]);
            if (p !== null && a !== null && p < PAGES && a < PAGE) return { space: 'page', page: p, addr: a };
            return null;
        }
        const n = parseNumber(s);
        const lab = findLabel(ctx.labels, s);
        // jméno návěští má přednost před hex bez předpony („CAFE“); desítkové číslo a $hex jsou vždy číslo
        if (lab && !/^(?:\$|0x|#)|^[0-9]+$/i.test(s)) return labelTarget(lab, ctx);
        if (n !== null) {
            if (ctx.space === 'page') return n < PAGE ? { space: 'page', page: ctx.page, addr: n } : null;
            return n <= 0xffff ? { space: 'cpu', addr: n } : null;
        }
        return lab ? labelTarget(lab, ctx) : null;
    }

    function labelTarget(l, ctx) {
        if (!hasPage(l)) return { space: 'cpu', addr: l.addr & 0xffff };
        if (ctx.space === 'page') return { space: 'page', page: l.page, addr: l.addr & (PAGE - 1) };
        // CPU: preferuj slot, kam návěští patří podle adresy; jinak kterýkoli slot se stránkou
        const own = (l.addr >> 13) & 7;
        if (slotPage(ctx.slots, own) === l.page) return { space: 'cpu', addr: l.addr & 0xffff };
        for (let s = 0; s < 8; s++) if (slotPage(ctx.slots, s) === l.page) return { space: 'cpu', addr: s * PAGE + (l.addr & (PAGE - 1)) };
        // stránka teď není namapovaná → ukaž ji fyzicky
        return { space: 'page', page: l.page, addr: l.addr & (PAGE - 1) };
    }

    /** Oblast řádku (CSS třída adresy): 'rom', 'code' nebo ''. */
    function regionOf(space, page, slots, codePages, romPages, i) {
        if (space === 'page') {
            if (romPages && romPages.has(page)) return 'rom';
            return codePages && codePages[page] ? 'code' : '';
        }
        const s = (i >> 13) & 7;
        if (isRomSlot(slots, s)) return 'rom';
        const p = slotPage(slots, s);
        return p >= 0 && codePages && codePages[p] ? 'code' : '';
    }

    /** Návrhy pro našeptávač: nejdřív začátek jména, pak obsahuje; nejvýš max. */
    function suggest(labels, text, max) {
        const q = String(text || '').trim().toLowerCase();
        const starts = [];
        const contains = [];
        const seen = new Set();
        for (const l of labels || []) {
            if (!l || typeof l.name !== 'string' || seen.has(l.name)) continue;
            const n = l.name.toLowerCase();
            if (!q || n.startsWith(q)) {
                seen.add(l.name);
                starts.push(l.name);
            } else if (n.indexOf(q) >= 0) {
                seen.add(l.name);
                contains.push(l.name);
            }
            if (starts.length >= max) break;
        }
        return starts.concat(contains).slice(0, max);
    }

    function b64(bytes) {
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
    }

    // ---- stav pohledu
    let api = null;
    let space = 'cpu';
    let page = 0;
    let data = null;           // Uint8Array zobrazeného prostoru
    let changed = null;        // Uint8Array 0/1
    let prev = null;           // {key, data} z minulého obnovení
    let slots = null;          // mmu.slots
    let symbols = null;        // {labels, codePages}
    let romPages = null;       // Set stránek ROM (pageUsage.rom), jen pro prostor stránky
    let placed = [];           // [{at, name}]
    let labelAt = new Map();   // index → [jména]
    let cursor = -1;           // vybraný bajt
    let editing = -1;          // upravovaný bajt
    let busy = null;
    let pendingPage = null;    // stránka z mapy paměti (před mount)
    let mounted = false;
    const els = {};
    const pool = [];           // znovupoužívané řádky {el, a, l, b[16], c}

    function size() {
        return space === 'page' ? PAGE : 0x10000;
    }

    function spaceKey() {
        return space === 'page' ? 'p' + page : 'cpu';
    }

    function fmtAddr(i) {
        return space === 'page' ? h2(page) + ':' + h4(i) : h4(i);
    }

    function fmtAddrHex(i) {
        return space === 'page' ? '$' + h2(page) + ':$' + h4(i) : '$' + h4(i);
    }

    // ---- DOM

    function mount(el, a) {
        api = a;
        mounted = true;
        el.appendChild(api.el('style', null, CSS));

        els.space = api.el('select', { title: t('memory.spaceTip'), onChange: () => setSpace(els.space.value, page) },
            api.el('option', { value: 'cpu' }, t('memory.spaceCpu')),
            api.el('option', { value: 'page' }, t('memory.spacePage')));
        els.page = api.el('input', { type: 'number', class: 'mx-page', min: '0', max: String(PAGES - 1), title: t('memory.pageTip') });
        els.page.value = String(page);
        els.page.addEventListener('change', () => {
            const p = parseNumber(els.page.value);
            if (p === null || p >= PAGES) {
                message(t('memory.badPage', els.page.value, PAGES - 1), 'err');
                els.page.value = String(page);
                return;
            }
            setSpace('page', p);
        });
        els.pageLabel = api.el('label', { title: t('memory.pageTip') }, t('memory.page') + ' ', els.page);
        els.list = api.el('datalist', { id: 'mx-labels' });
        els.addr = api.el('input', { type: 'text', class: 'mx-addr', list: 'mx-labels', placeholder: t('memory.addrPlaceholder'),
            title: t('memory.addrTip') });
        els.addr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') go(els.addr.value);
        });
        els.addr.addEventListener('input', (e) => {
            updateSuggestions();
            // výběr z našeptávače (datalist) = rovnou skok
            if (e && e.inputType === 'insertReplacementText' && symbols && findLabel(symbols.labels, els.addr.value)) go(els.addr.value);
        });
        els.go = api.el('button', { title: t('memory.goTip'), onClick: () => go(els.addr.value) }, t('memory.go'));
        el.appendChild(api.el('div', { class: 'toolbar' }, els.space, els.pageLabel, els.addr, els.list, els.go));

        els.info = api.el('div', { class: 'mx-info mono muted' });
        els.legend = api.el('div', { class: 'mx-legend muted' },
            api.el('span', { class: 'sw code' }), t('memory.legendCode'),
            api.el('span', { class: 'sw rom' }), t('memory.legendRom'),
            api.el('span', { class: 'sw chg' }), t('memory.legendChanged'),
            api.el('span', { class: 'muted' }, '  ·  ' + t('memory.editTip')));
        els.sel = api.el('div', { class: 'mx-sel mono' });
        els.msg = api.el('div', { class: 'mx-msg' });
        el.appendChild(els.info);
        el.appendChild(els.legend);

        els.rows = api.el('div', { class: 'mx-rows' });
        els.spacer = api.el('div', { class: 'mx-spacer' }, els.rows);
        els.view = api.el('div', { class: 'mx-view mono' }, els.spacer);
        els.view.addEventListener('scroll', () => render());
        el.appendChild(els.view);
        el.appendChild(els.sel);
        el.appendChild(els.msg);

        els.edit = api.el('input', { type: 'text', maxlength: '4', spellcheck: 'false' });
        els.edit.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commitEdit(els.edit.value);
            else if (e.key === 'Escape') cancelEdit();
        });
        els.edit.addEventListener('blur', () => {
            if (editing >= 0) cancelEdit();
        });

        if (pendingPage !== null) applyShow(pendingPage, false);
        syncControls();
        layout();
        if (!api.state.attached) els.info.textContent = t('memory.noSession');
    }

    function syncControls() {
        if (!els.space) return;
        els.space.value = space;
        els.page.value = String(page);
        els.pageLabel.hidden = space !== 'page';
    }

    function message(text, kind) {
        if (!els.msg) return;
        els.msg.textContent = text || '';
        els.msg.className = 'mx-msg' + (kind ? ' ' + kind : '');
    }

    function newRow() {
        const r = { a: api.el('span', { class: 'mx-a' }), l: api.el('span', { class: 'mx-l' }), b: [], c: api.el('span', { class: 'mx-c' }) };
        r.el = api.el('div', { class: 'mx-row' }, r.a, r.l);
        for (let j = 0; j < ROW; j++) {
            const s = api.el('span', { class: 'mx-b' });
            s._i = -1;
            s.addEventListener('click', () => select(s._i));
            s.addEventListener('dblclick', () => startEdit(s._i));
            s.addEventListener('mouseover', () => {
                if (s._i >= 0) s.title = byteInfo(s._i);
            });
            r.b.push(s);
            r.el.appendChild(s);
        }
        r.el.appendChild(r.c);
        return r;
    }

    /** Výška prostoru podle počtu řádků (spacer) a vykreslení viditelných. */
    function layout() {
        els.spacer.style.height = (size() / ROW) * ROW_H + 'px';
        render();
    }

    /** Vykreslí jen řádky ve viditelné části (+ OVERSCAN); řádky DOM se znovu používají. */
    function render() {
        if (!els.view) return;
        const total = size() / ROW;
        const h = els.view.clientHeight || FALLBACK_ROWS * ROW_H;
        const first = Math.max(0, Math.min(total - 1, Math.floor((els.view.scrollTop || 0) / ROW_H) - OVERSCAN));
        const count = Math.min(total - first, Math.ceil(h / ROW_H) + 2 * OVERSCAN);
        while (pool.length < count) {
            const r = newRow();
            pool.push(r);
            els.rows.appendChild(r.el);
        }
        for (let k = 0; k < pool.length; k++) {
            const r = pool[k];
            if (k >= count) {
                if (!r.el.hidden) r.el.hidden = true;
                continue;
            }
            if (r.el.hidden) r.el.hidden = false;
            fillRow(r, first + k);
        }
        els.rows.style.top = first * ROW_H + 'px';
    }

    function fillRow(r, row) {
        const base = row * ROW;
        r.a.textContent = fmtAddr(base);
        const reg = symbols || slots || romPages ? regionOf(space, page, slots, symbols && symbols.codePages, romPages, base) : '';
        r.a.className = 'mx-a' + (reg ? ' ' + reg : '');
        r.a.title = reg === 'rom' ? t('memory.legendRom') : reg === 'code' ? t('memory.legendCode') : '';
        const slotStart = base % PAGE === 0 && base > 0;
        const rowCls = 'mx-row' + (slotStart ? ' slot' : '');
        if (r.el.className !== rowCls) r.el.className = rowCls;
        const names = [];
        let ascii = '';
        for (let j = 0; j < ROW; j++) {
            const i = base + j;
            const s = r.b[j];
            s._i = i;
            s.title = '';
            const lab = labelAt.get(i);
            if (lab) names.push(...lab);
            const has = data && i < data.length;
            const v = has ? data[i] : 0;
            let cls = 'mx-b' + (j === 8 ? ' gap' : '');
            if (lab) cls += ' lbl';
            if (has && changed && changed[i]) cls += ' chg';
            if (i === cursor) cls += ' cur';
            if (s.className !== cls) s.className = cls;
            if (i === editing) {
                if (els.edit.parentNode !== s) {
                    s.textContent = '';
                    s.appendChild(els.edit);
                }
            } else {
                s.textContent = has ? h2(v) : '--';
            }
            ascii += has && v >= 32 && v < 127 ? String.fromCharCode(v) : has ? '.' : ' ';
        }
        r.l.textContent = names.length ? names[0] + (names.length > 1 ? ' +' + (names.length - 1) : '') : '';
        r.l.title = names.join('\n');
        r.c.textContent = ascii;
    }

    /** Text o bajtu: adresa, hodnota, stránka (v CPU), nejbližší návěští. */
    function byteInfo(i) {
        if (!data || i < 0 || i >= data.length) return fmtAddrHex(i);
        const v = data[i];
        const parts = [fmtAddrHex(i) + ' = $' + h2(v) + '  ' + v + '  %' + v.toString(2).padStart(8, '0')];
        if (space === 'cpu' && slots) {
            const s = (i >> 13) & 7;
            const p = slotPage(slots, s);
            parts.push(isRomSlot(slots, s) ? 'MMU' + s + ': ROM' : t('memory.slotPage', s, p >= 0 ? p : '?', '$' + h4(i & (PAGE - 1))));
        }
        const k = labelBefore(placed, i);
        if (k >= 0) parts.push(i === placed[k].at ? placed[k].name : placed[k].name + '+' + (i - placed[k].at));
        if (changed && changed[i] && prev) parts.push(t('memory.changedFrom', '$' + h2(prev.old[i])));
        return parts.join('  ·  ');
    }

    function select(i) {
        if (i < 0) return;
        cursor = i;
        els.sel.textContent = byteInfo(i);
        render();
    }

    /** Posune výpis tak, aby byl řádek s bajtem i nahoře (o řádek níž), a vybere ho. */
    function scrollTo(i) {
        const row = Math.floor(i / ROW);
        els.view.scrollTop = Math.max(0, (row - 1) * ROW_H);
        cursor = i;
        render();
        if (data) els.sel.textContent = byteInfo(i);
    }

    function setSpace(sp, p) {
        const changedSpace = sp !== space || (sp === 'page' && p !== page);
        space = sp === 'page' ? 'page' : 'cpu';
        page = p;
        syncControls();
        if (!changedSpace) return;
        data = null;
        changed = null;
        cursor = -1;
        editing = -1;
        rebuildLabels();
        els.view.scrollTop = 0;
        layout();
        reload();
    }

    function rebuildLabels() {
        placed = placeLabels(symbols && symbols.labels, space, page, slots);
        labelAt = new Map();
        for (const p of placed) {
            const list = labelAt.get(p.at);
            if (list) list.push(p.name);
            else labelAt.set(p.at, [p.name]);
        }
    }

    function updateSuggestions() {
        const names = suggest(symbols && symbols.labels, els.addr.value, MAX_SUGGEST);
        els.list.replaceChildren(...names.map((n) => api.el('option', { value: n })));
    }

    async function go(text) {
        const target = parseAddress(text, { labels: symbols && symbols.labels, space, page, slots });
        if (!target) {
            message(t('memory.badAddress', String(text).trim()), 'err');
            return;
        }
        message('');
        if (target.space !== space || (target.space === 'page' && target.page !== page)) {
            setSpace(target.space, target.space === 'page' ? target.page : page);
            if (busy) await busy.catch(() => {});
        }
        scrollTo(target.addr);
    }

    // ---- úprava bajtu

    function startEdit(i) {
        if (i < 0 || !data) return;
        if (!api.state.paused) {
            message(t('memory.editPaused'), 'warn');
            return;
        }
        cursor = i;
        editing = i;
        els.edit.value = h2(data[i]);
        render();
        if (els.edit.focus) els.edit.focus();
        if (els.edit.select) els.edit.select();
    }

    function cancelEdit() {
        editing = -1;
        render();
    }

    async function commitEdit(text) {
        const i = editing;
        if (i < 0) return;
        const v = parseByte(text);
        if (v === null) {
            message(t('memory.badByte'), 'err');
            return;
        }
        editing = -1;
        if (!api.state.paused) {
            message(t('memory.editPaused'), 'warn');
            render();
            return;
        }
        const args = space === 'page' ? { addr: i, data: b64([v]), page } : { addr: i, data: b64([v]) };
        try {
            await api.request('writeMemory', args);
            if (data) data[i] = v;
            if (changed) changed[i] = 1;
            message(t('memory.written', fmtAddrHex(i), '$' + h2(v)));
        } catch (e) {
            message(t('memory.writeFailed', (e && e.message) || e), 'err');
        }
        render();
        if (data) els.sel.textContent = byteInfo(i);
    }

    // ---- přepnutí z mapy paměti

    function applyShow(p, load) {
        pendingPage = null;
        space = 'page';
        page = p;
        data = null;
        changed = null;
        cursor = 0;
        editing = -1;
        syncControls();
        rebuildLabels();
        if (els.view) {
            els.view.scrollTop = 0;
            layout();
        }
        if (load) reload();
    }

    window.addEventListener('mbx-show-memory', (e) => {
        const p = e && e.detail ? Number(e.detail.page) : NaN;
        if (!Number.isInteger(p) || p < 0 || p >= PAGES) return;
        if (mounted) applyShow(p, true);
        else pendingPage = p;
    });

    // ---- data

    function infoLine() {
        if (space === 'cpu' && slots) {
            const m = [];
            for (let s = 0; s < 8; s++) m.push(isRomSlot(slots, s) ? 'ROM' : h2(slotPage(slots, s)));
            els.info.textContent = 'MMU0–7: ' + m.join(' ');
        } else if (space === 'page') {
            const bank = page >> 1;
            els.info.textContent = t('memory.pageLine', page, '$' + h2(page), bank, (page & 1) ? '$2000' : '$0000');
        } else els.info.textContent = '';
        const n = placed.length;
        let cnt = 0;
        if (changed) for (let i = 0; i < changed.length; i++) cnt += changed[i];
        const extra = [];
        if (symbols && symbols.labels && symbols.labels.length) extra.push(t('memory.labelsCount', n));
        if (prev && cnt) extra.push(t('memory.changedCount', cnt));
        if (extra.length) els.info.textContent += '  ·  ' + extra.join('  ·  ');
    }

    async function load(a) {
        const wantSymbols = !symbols || a.state.paused;
        const sp = space;
        const pg = page;
        const [mem, mmu, sym, usage] = await Promise.all([
            sp === 'page' ? a.request('readMemory', { page: pg, addr: 0, length: PAGE }) : a.request('readMemory', { addr: 0, length: 0x10000 }),
            a.request('mmu').catch(() => null),
            wantSymbols ? a.request('symbols').catch(() => null) : Promise.resolve(symbols),
            sp === 'page' && (!romPages || a.state.paused) ? a.request('pageUsage').catch(() => null) : Promise.resolve(null),
        ]);
        if (sp !== space || pg !== page) return;   // mezitím přepnuto
        const d = a.bytes(mem && mem.data);
        const full = new Uint8Array(sp === 'page' ? PAGE : 0x10000);
        full.set(d.subarray(0, full.length));
        slots = mmu && Array.isArray(mmu.slots) ? mmu.slots : null;
        if (sym) symbols = { labels: Array.isArray(sym.labels) ? sym.labels : [], codePages: sym.codePages || {} };
        if (usage) romPages = new Set(Array.isArray(usage.rom) ? usage.rom : []);
        const key = spaceKey();
        changed = new Uint8Array(full.length);
        let old = null;
        if (prev && prev.key === key && prev.data.length === full.length) {
            old = prev.data;
            for (let i = 0; i < full.length; i++) if (old[i] !== full[i]) changed[i] = 1;
        }
        prev = { key, data: full.slice(), old: old || full.slice() };
        data = full;
        rebuildLabels();
        infoLine();
        render();
        if (cursor >= 0) els.sel.textContent = byteInfo(cursor);
    }

    function reload() {
        if (!api || !api.state.attached) return;
        refresh(api).catch((e) => message(t('memory.error', (e && e.message) || e), 'err'));
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.info.textContent = t('memory.noSession');
            return;
        }
        while (busy) await busy.catch(() => {});
        if (editing >= 0) return;   // neobnovuj pod rukama rozepsanou úpravu
        busy = load(a);
        try {
            await busy;
        } finally {
            busy = null;
        }
    }

    NextView.register({
        id: ID, title: t('memory.title'), order: 85, mount, refresh,
        // pro testy (docs/testing.md): čisté funkce bez DOM
        helpers: { parseNumber, parseByte, parseAddress, placeLabels, labelBefore, regionOf, suggest, slotPage, ROW_H, OVERSCAN, FALLBACK_ROWS },
    });
})();
