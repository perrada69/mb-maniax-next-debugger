// Pohled NEXTREG: registry s hodnotou hex/dec/bin a rozpisem bitů, filtr a zvýraznění změn od minulého obnovení.
// Jména a bity bere z NextRegNames (nextreg-names.js).
(function () {
    const STYLE = `
#view-nextreg .nr-table td.val { text-align: right; }
#view-nextreg .nr-table td.fields { white-space: normal; min-width: 260px; }
#view-nextreg .nr-field { display: inline-block; margin-right: 10px; }
#view-nextreg .nr-field b { font-weight: normal; color: var(--vscode-textLink-foreground); }
#view-nextreg .nr-bit.set { color: var(--vscode-foreground); }
#view-nextreg .nr-bit { color: var(--vscode-descriptionForeground); }
#view-nextreg .nr-bit.diff { color: var(--vscode-editorWarning-foreground); font-weight: bold; }
#view-nextreg tr.changed td { background: var(--vscode-editor-findMatchHighlightBackground); }
#view-nextreg tr.changed td.val { color: var(--vscode-editorWarning-foreground); }
#view-nextreg .nr-acc { color: var(--vscode-descriptionForeground); cursor: default; }
#view-nextreg .nr-acc.note { text-decoration: underline dotted; }
#view-nextreg .nr-desc { color: var(--vscode-descriptionForeground); margin-left: 6px; }
#view-nextreg .nr-search { width: 14em; }
`;
    const t = NextView.t;
    const ACCESS = { rw: t('nextreg.access.rw'), r: t('nextreg.access.r'), w: t('nextreg.access.w') };
    const ACCESS_TITLE = {
        rw: t('nextreg.accessTitle.rw'),
        r: t('nextreg.accessTitle.r'),
        w: t('nextreg.accessTitle.w'),
    };

    let api = null;
    let rows = [];          // {n, def, tr, hex, dec, bits[8], vals[], hay, v}
    let prev = null;        // data z minulého obnovení
    let filterText = '';
    let group = '';
    let showAll = false;    // i nedefinované registry
    let onlyChanged = false;
    let countEl = null;

    function h2(v) {
        return v.toString(16).toUpperCase().padStart(2, '0');
    }

    function buildRow(n, names) {
        const def = names ? names.get(n) : null;
        const el = api.el;
        const hex = el('td', { class: 'mono val' }, '');
        const dec = el('td', { class: 'mono val' }, '');
        const bits = [];
        const binTd = el('td', { class: 'mono' });
        for (let b = 7; b >= 0; b--) {
            const s = el('span', { class: 'nr-bit' }, '0');
            bits[b] = s;
            binTd.appendChild(s);
            if (b === 4) binTd.appendChild(document.createTextNode(' '));
        }
        const vals = [];
        const fieldsTd = el('td', { class: 'fields' });
        if (def) {
            for (const f of def.fields) {
                const b = el('b', null, '');
                vals.push(b);
                const bitsTitle = f.hi === f.lo ? t('nextreg.bitTitle', f.hi) : t('nextreg.bitsTitle', f.hi + ':' + f.lo);
                fieldsTd.appendChild(el('span', { class: 'nr-field', title: bitsTitle }, f.label + ': ', b));
            }
        }
        let accTitle = def ? ACCESS_TITLE[def.access] : '';
        if (def && def.rw) accTitle += '\n' + def.rw;
        const acc = def
            ? el('span', { class: 'nr-acc' + (def.rw ? ' note' : ''), title: accTitle }, ACCESS[def.access] + (def.rw ? '*' : ''))
            : '';
        const nameTitle = def ? (def.desc ? def.desc + '\n' : '') + (def.fromJnext ? t('nextreg.nameFromJnext') : t('nextreg.nameFromDocs')) : '';
        const tr = el('tr', null,
            el('td', { class: 'mono' }, '$' + h2(n)),
            el('td', { title: nameTitle }, def ? def.name : '—', def && def.desc ? el('span', { class: 'nr-desc' }, def.desc) : ''),
            el('td', { class: 'muted' }, def ? def.group : ''),
            el('td', null, acc),
            hex, dec, binTd, fieldsTd);
        const hay = ['$' + h2(n), h2(n), '0x' + h2(n), String(n)]
            .concat(def ? [def.name, def.desc, def.group, def.rw].concat(def.fields.map((f) => f.label)) : [])
            .join('\n').toLowerCase();
        return { n, def, tr, hex, dec, bits, vals, hay, v: -1 };
    }

    function visible(r) {
        if (!r.def && !showAll) return false;
        if (group && (!r.def || r.def.group !== group)) return false;
        if (onlyChanged && !r.tr.classList.contains('changed')) return false;
        if (filterText && r.hay.indexOf(filterText) < 0) return false;
        return true;
    }

    function applyFilter() {
        let shown = 0;
        let changed = 0;
        for (const r of rows) {
            const vis = visible(r);
            if (r.tr.hidden === vis) r.tr.hidden = !vis;
            if (vis) shown++;
            if (r.tr.classList.contains('changed')) changed++;
        }
        countEl.textContent = prev ? t('nextreg.countChanged', shown, changed) : t('nextreg.count', shown);
    }

    function mount(el, a) {
        api = a;
        const names = window.NextRegNames || null;
        el.appendChild(api.el('style', null, STYLE));

        const search = api.el('input', { type: 'text', class: 'nr-search', placeholder: t('nextreg.searchPlaceholder') });
        search.addEventListener('input', () => {
            filterText = search.value.trim().toLowerCase();
            applyFilter();
        });
        const sel = api.el('select', { title: t('nextreg.groupTitle') }, api.el('option', { value: '' }, t('nextreg.allGroups')));
        for (const g of names ? names.groups : []) sel.appendChild(api.el('option', { value: g }, g));
        sel.addEventListener('change', () => {
            group = sel.value;
            applyFilter();
        });
        const all = api.el('input', { type: 'checkbox' });
        all.addEventListener('change', () => {
            showAll = all.checked;
            applyFilter();
        });
        const chg = api.el('input', { type: 'checkbox' });
        chg.addEventListener('change', () => {
            onlyChanged = chg.checked;
            applyFilter();
        });
        countEl = api.el('span', { class: 'muted' }, '');
        el.appendChild(api.el('div', { class: 'toolbar' },
            search, sel,
            api.el('label', { title: t('nextreg.showAllTitle') }, all, ' ' + t('nextreg.showAll')),
            api.el('label', { title: t('nextreg.onlyChangedTitle') }, chg, ' ' + t('nextreg.onlyChanged')),
            countEl));
        if (!names) el.appendChild(api.el('div', { class: 'muted' }, t('nextreg.noNames')));

        const tbody = api.el('tbody');
        rows = [];
        for (let n = 0; n < 256; n++) {
            const r = buildRow(n, names);
            rows.push(r);
            tbody.appendChild(r.tr);
        }
        el.appendChild(api.el('table', { class: 'table nr-table' },
            api.el('thead', null, api.el('tr', null,
                api.el('th', null, t('nextreg.col.reg')), api.el('th', null, t('nextreg.col.name')), api.el('th', null, t('nextreg.col.group')),
                api.el('th', { title: t('nextreg.col.accessTitle') }, t('nextreg.col.access')),
                api.el('th', null, 'Hex'), api.el('th', null, 'Dec'), api.el('th', null, 'Bin'),
                api.el('th', { title: t('nextreg.col.bitsTitle') }, t('nextreg.col.bits')))),
            tbody));
        applyFilter();
    }

    async function refresh(a) {
        api = a;
        const res = await api.request('nextregs');
        const data = api.bytes(res.data);
        const names = window.NextRegNames || null;
        for (const r of rows) {
            const v = data.length > r.n ? data[r.n] : 0;
            const was = prev ? prev[r.n] : v;
            const changed = was !== v;
            if (r.tr.classList.contains('changed') !== changed) r.tr.classList.toggle('changed', changed);
            const diff = was ^ v;
            for (let b = 0; b < 8; b++) {
                const cls = 'nr-bit' + ((v >> b) & 1 ? ' set' : '') + ((diff >> b) & 1 ? ' diff' : '');
                if (r.bits[b].className !== cls) r.bits[b].className = cls;
            }
            if (v === r.v) continue;
            r.v = v;
            r.hex.textContent = '$' + h2(v);
            r.dec.textContent = String(v);
            for (let b = 0; b < 8; b++) r.bits[b].textContent = (v >> b) & 1 ? '1' : '0';
            if (r.def && names) {
                const parts = names.decode(r.n, v);
                for (let i = 0; i < r.vals.length; i++) r.vals[i].textContent = parts[i] ? parts[i].text : '';
            }
        }
        prev = data;
        applyFilter();
    }

    NextView.register({ id: 'nextreg', title: 'NEXTREG', order: 80, mount, refresh });
})();
