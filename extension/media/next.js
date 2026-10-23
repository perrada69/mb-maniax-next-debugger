// Panel „Next“: záložky s pohledy na hardware Nextu. Pohledy (media/views/*.js) se registrují
// přes NextView.register a data si berou přes `api` (smlouva v docs/next-views.md).
(function () {
    const vscode = acquireVsCodeApi();
    const tabsEl = document.getElementById('tabs');
    const content = document.getElementById('content');
    const status = document.getElementById('status');
    const refreshBtn = document.getElementById('refresh');
    const liveBox = document.getElementById('live');

    const LIVE_MS = 500;   // „Živě“: 2× za sekundu
    const views = [];      // {def, tab, pane, error, el, mounted, broken}
    let current = null;    // zobrazená záložka
    let attached = false;
    let paused = false;
    let busy = false;      // běží refresh (další se nepouští)
    let again = false;     // během refresh přišel podnět (zastavení, Obnovit) → ještě jednou
    const saved = vscode.getState() || {};

    // ---- dotazy na server přes rozšíření
    const pending = new Map();
    let nextId = 1;

    function request(cmd, args) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            vscode.postMessage({ type: 'request', id, cmd, args: args || {} });
        });
    }

    function onResponse(m) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error || t('next.error')));
    }

    // ---- pomocníci pro pohledy
    function bytes(base64) {
        const s = atob(base64 || '');
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    /** RGB333 (bity 8–6 R, 5–3 G, 2–0 B) → [r, g, b] po 8 bitech. */
    function rgb(c) {
        const c8 = (v) => ((v << 5) | (v << 2) | (v >> 1)) & 0xff;
        return [c8((c >> 6) & 7), c8((c >> 3) & 7), c8(c & 7)];
    }

    function css(c) {
        return '#' + rgb(c).map((v) => v.toString(16).padStart(2, '0')).join('');
    }

    // ---- překlady: slovník vybraného jazyka vloží rozšíření (window.L10N, src/i18n.ts)
    const l10n = window.L10N || { lang: 'en', texts: {} };

    /** Text podle klíče; {0}, {1} … nahradí argumenty; bez překladu vrátí klíč. */
    function t(key, ...args) {
        const s = l10n.texts[key] ?? key;
        return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
    }

    function hex(v, digits) {
        return '$' + (v >>> 0).toString(16).toUpperCase().padStart(digits || 2, '0');
    }

    function canvas(width, height, scale) {
        const c = document.createElement('canvas');
        const s = scale || 1;
        c.width = width;
        c.height = height;
        c.style.width = width * s + 'px';
        c.style.height = height * s + 'px';
        c.style.imageRendering = 'pixelated';
        c.getContext('2d').imageSmoothingEnabled = false;
        return c;
    }

    function append(parent, child) {
        if (child === null || child === undefined || child === false) return;
        if (Array.isArray(child)) child.forEach((c) => append(parent, c));
        else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    /** el('div', {class: 'x', onClick: f}, 'text', child…); attrs lze vynechat. */
    function el(tag, attrs, ...children) {
        const e = document.createElement(tag);
        if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
            children.unshift(attrs);
            attrs = null;
        }
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'title') e.title = v;
            else if (k === 'style') {
                if (typeof v === 'string') e.style.cssText = v;
                else Object.assign(e.style, v);
            } else if (/^on[A-Z]/.test(k) && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v === true ? '' : v);
        }
        append(e, children);
        return e;
    }

    const api = {
        request,
        bytes,
        rgb,
        css,
        hex,
        canvas,
        el,
        t,
        lang: l10n.lang,
        highlight(rect) {
            vscode.postMessage({ type: 'highlight', rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null });
        },
    };
    Object.defineProperty(api, 'state', { get: () => Object.freeze({ attached, paused }), enumerable: true });
    Object.freeze(api);

    // ---- registrace pohledů (skripty media/views/*.js se načtou po tomto souboru)
    window.NextView = Object.freeze({
        t,
        lang: l10n.lang,
        register(def) {
            if (!def || typeof def.id !== 'string' || views.some((v) => v.def.id === def.id)) {
                console.error('NextView.register: missing or duplicate id', def && def.id);
                return;
            }
            views.push({ def, mounted: false });
        },
        /** Přepne na záložku podle id (např. z Mapy paměti na Paměť); neznámé id nic nedělá. */
        show(id) {
            const v = views.find((x) => x.def.id === id);
            if (v && v.tab) select(v);
            return !!v;
        },
    });

    function errorText(e) {
        return (e && e.message) || String(e);
    }

    function showError(v, e) {
        v.error.textContent = e ? errorText(e) : '';
        v.error.hidden = !e;
    }

    function init() {
        views.sort((a, b) => (a.def.order ?? 0) - (b.def.order ?? 0) || String(a.def.title).localeCompare(String(b.def.title)));
        for (const v of views) {
            v.tab = el('button', { class: 'tab', role: 'tab', onClick: () => select(v) }, v.def.title || v.def.id);
            v.error = el('div', { class: 'view-error' });
            v.error.hidden = true;
            v.el = el('div', { id: 'view-' + v.def.id, class: 'view' });
            v.pane = el('div', { class: 'pane', role: 'tabpanel' }, v.error, v.el);
            v.pane.hidden = true;
            tabsEl.appendChild(v.tab);
            content.appendChild(v.pane);
        }
        if (!views.length) content.appendChild(el('div', { class: 'muted empty' }, t('next.noViews')));
        liveBox.checked = !!saved.live;
        liveBox.addEventListener('change', () => {
            save();
            if (liveBox.checked) refresh();
        });
        refreshBtn.addEventListener('click', () => refresh());
        const first = views.find((v) => v.def.id === saved.tab) || views[0];
        if (first) select(first);
        showStatus();
        setInterval(liveTick, LIVE_MS);
        window.addEventListener('message', (ev) => onMessage(ev.data));
        vscode.postMessage({ type: 'ready' });
    }

    function save() {
        vscode.setState({ tab: current && current.def.id, live: liveBox.checked });
    }

    /** Přepnutí záložky: mount při prvním zobrazení, refresh když stroj stojí nebo je zapnuté Živě. */
    function select(v) {
        if (current === v) return;
        if (current) {
            current.tab.classList.remove('active');
            current.tab.setAttribute('aria-selected', 'false');
            current.pane.hidden = true;
        }
        api.highlight(null);   // zvýraznění patří předchozí záložce
        current = v;
        v.tab.classList.add('active');
        v.tab.setAttribute('aria-selected', 'true');
        v.pane.hidden = false;
        save();
        if (!v.mounted) {
            v.mounted = true;
            try {
                if (typeof v.def.mount === 'function') v.def.mount(v.el, api);
            } catch (e) {
                v.broken = true;   // pohled bez mount se neobnovuje, chyba zůstane vidět
                showError(v, new Error(t('next.viewFailed', errorText(e))));
            }
        }
        if (attached && (paused || liveBox.checked)) refresh();
    }

    /** Obnoví zobrazenou záložku; když už refresh běží, proběhne ještě jednou po něm. */
    async function refresh() {
        if (busy) {
            again = true;
            return;
        }
        const v = current;
        if (!v || v.broken) return;
        if (!attached) {
            showError(v, null);
            return;
        }
        busy = true;
        try {
            if (typeof v.def.refresh === 'function') await v.def.refresh(api);
            showError(v, null);
        } catch (e) {
            showError(v, e);
        } finally {
            busy = false;
        }
        if (again) {
            again = false;
            refresh();
        }
    }

    function liveTick() {
        if (liveBox.checked && attached && !paused && !busy && !document.hidden) refresh();
    }

    function showStatus() {
        if (!attached) status.textContent = t('next.waiting');
        else status.textContent = paused ? t('next.stopped') : t('next.running');
        refreshBtn.disabled = !attached;
    }

    function onMessage(m) {
        switch (m && m.type) {
            case 'response':
                onResponse(m);
                break;
            case 'attached':
                attached = true;
                paused = false;
                showStatus();
                break;
            case 'detached':
                attached = false;
                paused = false;
                showStatus();
                break;
            case 'stopped':
                paused = true;
                showStatus();
                refresh();
                break;
            case 'continued':
                paused = false;
                showStatus();
                break;
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 0);
})();
