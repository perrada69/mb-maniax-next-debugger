// Pohled „WiFi (ESP)“: provoz mezi programem a emulovaným modulem ESP-01 na UART 0 – co program
// poslal (příkazy AT, data za AT+CIPSEND) a co mu modul odpověděl (OK, ERROR, +IPD …), po řádcích
// se snímkem; nahoře stav modulu a poslední události spojení. Data z `espLog` (jen nové kusy od
// posledního seq; server je drží i bez otevřeného pohledu) a `espState`, vymazání `espClear`.
// Kus záznamu končí koncem řádku (\n) nebo změnou směru (server/esp_tap.h).
(function () {
    'use strict';

    const ID = 'esp';
    const MAX_ROWS = 5000;    // víc řádků v DOM nedržet (starší odpadnou, server má víc)
    const SHORT = 160;        // delší kus se zkrátí, klik ho rozbalí
    // události spojení z JNEXT (esp_event_text) → překlad
    const EVENT_KEYS = { opened: 'esp.evOpened', closed: 'esp.evClosed', refused: 'esp.evRefused', failed: 'esp.evFailed', fault: 'esp.evFault' };

    const CSS = `
#view-esp .esp-info { margin-bottom: 4px; }
#view-esp .esp-info .on { color: var(--vscode-charts-green); }
#view-esp .esp-info .off { color: var(--vscode-descriptionForeground); }
#view-esp .esp-events { margin: 2px 0 6px; }
#view-esp .esp-events td { padding: 0 6px 0 0; }
#view-esp .esp-ev-refused, #view-esp .esp-ev-failed, #view-esp .esp-ev-fault { color: var(--vscode-errorForeground); }
#view-esp .esp-ev-opened { color: var(--vscode-charts-green); }
#view-esp .toolbar input[type=text] { width: 14em; }
#view-esp .esp-log { height: calc(100vh - 170px); min-height: 120px; overflow: auto;
    border: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); }
#view-esp .esp-row { display: flex; gap: 8px; padding: 0 4px; white-space: pre-wrap; word-break: break-all; cursor: default; }
#view-esp .esp-row:hover { background: var(--vscode-list-hoverBackground); }
#view-esp .esp-row.long { cursor: pointer; }
#view-esp .esp-frame { flex: none; width: 6.5em; text-align: right; color: var(--vscode-descriptionForeground); }
#view-esp .esp-dir { flex: none; width: 1.5em; text-align: center; }
#view-esp .esp-row.tx .esp-dir { color: var(--vscode-charts-blue); }
#view-esp .esp-row.rx .esp-dir { color: var(--vscode-charts-orange); }
#view-esp .esp-data { flex: 1; min-width: 0; }
#view-esp .esp-c { color: var(--vscode-descriptionForeground); }
#view-esp .esp-more { color: var(--vscode-textLink-foreground); }
#view-esp .esp-row.cmd .esp-data { font-weight: bold; }
#view-esp .esp-row.ok .esp-data { color: var(--vscode-charts-green); }
#view-esp .esp-row.err .esp-data { color: var(--vscode-errorForeground); }
#view-esp .esp-row.ipd .esp-ipd { color: var(--vscode-charts-purple); font-weight: bold; }
#view-esp .esp-row.evt .esp-data { color: var(--vscode-charts-yellow); }
#view-esp .esp-row.hidden { display: none; }
#view-esp .esp-empty { padding: 4px; }
`;

    const t = NextView.t;

    // ---- čisté funkce (testovatelné bez DOM)

    /** Bajty → text po bajtech (latin1, jako je program poslal). */
    function latin1(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    /**
     * Druh řádku pro zvýraznění: 'cmd' (příkaz AT od programu), 'ok', 'err', 'ipd' (data od modulu
     * s hlavičkou +IPD), 'evt' (CONNECT, CLOSED, WIFI …, odpověď s +), '' ostatní (data).
     */
    function classify(rx, text) {
        const s = text.replace(/[\r\n]+$/, '');
        if (!rx) return /^AT([+&][A-Z_]|$|[A-Z])/i.test(s) ? 'cmd' : '';
        if (/^\+IPD,/.test(s)) return 'ipd';
        if (/^(OK|SEND OK|ready)$/.test(s)) return 'ok';
        if (/^(ERROR|FAIL|SEND FAIL|busy [ps]\.\.\.|ALREADY CONNECTED|link is not valid|DNS Fail)$/.test(s)) return 'err';
        if (/^(\d,)?(CONNECT|CLOSED|CONNECT FAIL)$/.test(s) || /^WIFI /.test(s) || /^\+[A-Z]+:/.test(s) || s === '>') return 'evt';
        return '';
    }

    /**
     * Text → úseky [{text, ctrl}]: řídicí znaky jako značky (CR LF → ↵, jinak \xNN); `hex` = po
     * bajtech šestnáctkově. Délka nad `max` → zkrácení a {more: počet zbylých bajtů}.
     */
    function segments(text, hex, max) {
        const out = [];
        const n = max && text.length > max ? max : text.length;
        if (hex) {
            const parts = [];
            for (let i = 0; i < n; i++) parts.push(text.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0'));
            out.push({ text: parts.join(' '), ctrl: false });
        } else {
            let plain = '';
            const flush = () => {
                if (plain) out.push({ text: plain, ctrl: false });
                plain = '';
            };
            for (let i = 0; i < n; i++) {
                const c = text.charCodeAt(i);
                if (c === 13 && text.charCodeAt(i + 1) === 10 && i + 1 < n) {
                    flush();
                    out.push({ text: '↵', ctrl: true });
                    i++;
                } else if (c === 10 || c === 13) {
                    flush();
                    out.push({ text: c === 10 ? '\\n' : '\\r', ctrl: true });
                } else if (c < 32 || c === 127) {
                    flush();
                    out.push({ text: '\\x' + c.toString(16).toUpperCase().padStart(2, '0'), ctrl: true });
                } else plain += text[i];
            }
            flush();
        }
        if (n < text.length) out.push({ more: text.length - n });
        return out;
    }

    /** Délka hlavičky +IPD (včetně dvojtečky) na začátku kusu, jinak 0. */
    function ipdHeader(text) {
        const m = /^\+IPD,[0-9,]+:/.exec(text);
        return m ? m[0].length : 0;
    }

    /** Filtr řádků: prázdný = vše, jinak podřetězec bez ohledu na velikost písmen. */
    function matches(filter, text) {
        return !filter || text.toLowerCase().includes(filter.toLowerCase());
    }

    /** Záznam jako text (kopírování): snímek, směr, řádek s viditelnými řídicími znaky. */
    function asText(entries) {
        return entries
            .map((e) => `${e.frame}\t${e.rx ? 'ESP→Z80' : 'Z80→ESP'}\t` + segments(e.text, false, 0).map((s) => s.text).join(''))
            .join('\n');
    }

    // ---- DOM

    let api;
    const els = {};
    let epoch;               // epoch záznamu serveru (změna = začít znovu)
    let nextSeq = 0;         // příště se ptát od tohoto seq (poslední kus může růst)
    const rows = new Map();  // seq → {entry, row}
    let hex = false;
    let follow = true;
    let filter = '';

    function mount(el, a) {
        api = a;
        el.appendChild(api.el('style', null, CSS));
        els.info = api.el('div', { class: 'esp-info' });
        el.appendChild(els.info);
        els.events = api.el('table', { class: 'esp-events mono' });
        els.filter = api.el('input', { type: 'text', placeholder: t('esp.filter'), title: t('esp.filterTip') });
        els.filter.addEventListener('input', () => {
            filter = els.filter.value;
            for (const r of rows.values()) r.row.classList.toggle('hidden', !matches(filter, r.entry.text));
        });
        const hexBox = api.el('input', { type: 'checkbox' });
        hexBox.addEventListener('change', () => {
            hex = !!hexBox.checked;
            for (const r of rows.values()) paintRow(r);
        });
        const followBox = api.el('input', { type: 'checkbox' });
        followBox.checked = true;
        followBox.addEventListener('change', () => {
            follow = !!followBox.checked;
            if (follow) scrollEnd();
        });
        els.clear = api.el('button', { title: t('esp.clearTip'), onClick: () => void clearLog() }, t('esp.clear'));
        els.copy = api.el('button', { title: t('esp.copyTip'), onClick: () => void copyLog() }, t('esp.copy'));
        el.appendChild(api.el('div', { class: 'toolbar' },
            els.clear, els.copy, els.filter,
            api.el('label', { title: t('esp.hexTip') }, hexBox, ' ', t('esp.hex')),
            api.el('label', { title: t('esp.followTip') }, followBox, ' ', t('esp.follow'))));
        el.appendChild(els.events);
        els.log = api.el('div', { class: 'esp-log mono' });
        els.empty = api.el('div', { class: 'esp-empty muted' }, t('esp.empty'));
        els.log.appendChild(els.empty);
        el.appendChild(els.log);
        els.info.textContent = t('esp.noSession');
    }

    function reset() {
        rows.clear();
        els.log.replaceChildren(els.empty);
        els.empty.hidden = false;
        nextSeq = 0;
    }

    function scrollEnd() {
        els.log.scrollTop = els.log.scrollHeight || 1e9;
    }

    function paintRow(r) {
        const e = r.entry;
        const kind = classify(e.rx, e.text);
        r.row.className = 'esp-row ' + (e.rx ? 'rx' : 'tx') + (kind ? ' ' + kind : '') + (e.text.length > SHORT ? ' long' : '') +
            (matches(filter, e.text) ? '' : ' hidden');
        const data = r.data;
        data.replaceChildren();
        let text = e.text;
        const head = !hex && kind === 'ipd' ? ipdHeader(text) : 0;
        if (head) {
            data.appendChild(api.el('span', { class: 'esp-ipd' }, text.slice(0, head)));
            text = text.slice(head);
        }
        for (const s of segments(text, hex, r.open ? 0 : SHORT)) {
            if (s.more) data.appendChild(api.el('span', { class: 'esp-more' }, ' … ' + t('esp.more', s.more)));
            else data.append(s.ctrl ? api.el('span', { class: 'esp-c' }, s.text) : s.text);
        }
        r.row.title = t('esp.rowTip', e.seq, e.frame, e.t, e.text.length);
    }

    function addEntry(raw) {
        const entry = { seq: raw.seq, rx: raw.dir === 'rx', frame: raw.frame, t: raw.t, text: latin1(api.bytes(raw.data)) };
        let r = rows.get(entry.seq);
        if (r) {
            r.entry = entry;   // poslední kus mezitím narostl
        } else {
            const frame = api.el('span', { class: 'esp-frame' }, String(entry.frame));
            const dir = api.el('span', { class: 'esp-dir', title: entry.rx ? t('esp.dirRx') : t('esp.dirTx') }, entry.rx ? '←' : '→');
            const data = api.el('span', { class: 'esp-data' });
            const row = api.el('div', { class: 'esp-row' }, frame, dir, data);
            r = { entry, row, data, open: false };
            row.addEventListener('click', () => {
                if (r.entry.text.length <= SHORT) return;
                r.open = !r.open;
                paintRow(r);
            });
            rows.set(entry.seq, r);
            els.log.appendChild(row);
        }
        paintRow(r);
    }

    function trim() {
        while (rows.size > MAX_ROWS) {
            const [seq, r] = rows.entries().next().value;
            rows.delete(seq);
            r.row.remove();
        }
    }

    function paintState(st, log) {
        if (!st.enabled) {
            els.info.replaceChildren(api.el('span', { class: 'off' }, t('esp.disabled')));
            els.events.replaceChildren();
            return;
        }
        const parts = [
            api.el('span', { class: 'on' }, t('esp.enabled')),
            ' · ',
            st.associated ? t('esp.associated', st.stationIp) : api.el('span', { class: 'off' }, t('esp.notAssociated')),
            ' · ',
            st.allowedHosts && st.allowedHosts.length ? t('esp.allowedHosts', st.allowedHosts.join(', ')) : t('esp.anyHost'),
            ' · ',
            t('esp.bytes', log.bytesTx, log.bytesRx),
        ];
        els.info.replaceChildren(...parts);
        const evs = (st.events || []).slice(-5);
        els.events.replaceChildren(...evs.map((e) => {
            const cls = e.kind === 'transport fault' ? 'fault' : e.kind;
            const key = EVENT_KEYS[cls];
            return api.el('tr', { class: 'esp-ev-' + cls },
                api.el('td', null, key ? t(key) : e.kind),
                api.el('td', null, e.host ? `${e.host}:${e.port}` : ''),
                api.el('td', { class: 'muted' }, e.detail || ''));
        }));
    }

    async function clearLog() {
        if (!api || !api.state.attached) return;
        await api.request('espClear');
        reset();
        await refresh(api);
    }

    async function copyLog() {
        const text = asText([...rows.values()].filter((r) => matches(filter, r.entry.text)).map((r) => r.entry));
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // schránka ve webview nedostupná: nic
        }
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.info.textContent = t('esp.noSession');
            return;
        }
        const st = await a.request('espState');
        let log = await a.request('espLog', { since: nextSeq });
        if (log.epoch !== epoch || log.next < nextSeq) {
            // nové sezení nebo vymazání: znovu od začátku
            epoch = log.epoch;
            reset();
            log = await a.request('espLog', { since: 0 });
        }
        paintState(st, log);
        const atEnd = follow;
        for (const e of log.entries) addEntry(e);
        trim();
        if (log.entries.length) nextSeq = log.entries[log.entries.length - 1].seq;
        els.empty.hidden = rows.size > 0;
        els.empty.textContent = st.enabled ? t('esp.empty') : t('esp.emptyDisabled');
        if (atEnd && log.entries.length) scrollEnd();
    }

    NextView.register({
        id: ID, title: t('esp.title'), order: 88, mount, refresh,
        // pro testy (docs/testing.md): čisté funkce bez DOM
        helpers: { latin1, classify, segments, ipdHeader, matches, asText },
    });
})();
