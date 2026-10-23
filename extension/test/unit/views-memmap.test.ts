// Pohled Mapa paměti (media/views/memmap.js) nad podvrženým DOM a falešným serverem podle docs/next-views.md:
// obsazenost z pageUsage, MMU, kód ze SLD, banky 5/7, Layer 2 (NR $12/$13/$70), tilemapa, najetí, klik →
// pohled Paměť (událost mbx-show-memory), překlady.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'cs', 'sk', 'es', 'de', 'fr', 'it', 'pl', 'pt-br', 'ru', 'uk', 'ja', 'zh-cn'];
const AREAS = ['memmap', 'memory'];

// ---- podvržený DOM (jen to, co pohledy používají)
class FNode {
    parentNode: any = null;
}
class FText extends FNode {
    data: string;
    constructor(s: any) {
        super();
        this.data = String(s);
    }
    get textContent() {
        return this.data;
    }
    set textContent(v: any) {
        this.data = String(v);
    }
}
class FEl extends FNode {
    tagName: string;
    childNodes: any[] = [];
    attrs: Record<string, string> = {};
    style: any = {};
    listeners: Record<string, Function[]> = {};
    className = '';
    title = '';
    hidden = false;
    value = '';
    checked = false;
    scrollTop = 0;
    clientHeight = 0;
    id = '';
    classList: any;
    [k: string]: any;
    constructor(tag: string) {
        super();
        this.tagName = tag.toUpperCase();
        const self = this;
        this.classList = {
            contains: (c: string) => self.className.split(/\s+/).includes(c),
            add: (c: string) => {
                if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim();
            },
            remove: (c: string) => {
                self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
            },
            toggle: (c: string, on?: boolean) => {
                if (on === undefined) on = !self.classList.contains(c);
                if (on) self.classList.add(c);
                else self.classList.remove(c);
                return on;
            },
        };
    }
    appendChild(c: any) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.childNodes.push(c);
        return c;
    }
    removeChild(c: any) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) this.childNodes.splice(i, 1);
        c.parentNode = null;
        return c;
    }
    replaceChildren(...cs: any[]) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = [];
        for (const c of cs) this.appendChild(typeof c === 'string' ? new FText(c) : c);
    }
    get textContent(): string {
        return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v: any) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = v === '' || v === null || v === undefined ? [] : [new FText(v)];
    }
    setAttribute(k: string, v: any) {
        this.attrs[k] = String(v);
        if (k === 'id') this.id = String(v);
    }
    getAttribute(k: string) {
        return k in this.attrs ? this.attrs[k] : null;
    }
    addEventListener(t: string, f: Function) {
        (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    dispatch(t: string, ev: any = {}) {
        for (const f of this.listeners[t] || []) f({ target: this, ...ev });
    }
    focus() {}
    select() {}
}
const document = { createElement: (t: string) => new FEl(t), createTextNode: (s: any) => new FText(s) };

function append(parent: any, child: any) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => append(parent, c));
    else parent.appendChild(child instanceof FNode ? child : document.createTextNode(String(child)));
}
/** Kopie api.el z media/next.js. */
function el(tag: string, attrs?: any, ...children: any[]) {
    const e: any = document.createElement(tag);
    if (attrs && (typeof attrs !== 'object' || attrs instanceof FNode || Array.isArray(attrs))) {
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
function find(root: any, pred: (e: any) => boolean, out: any[] = []): any[] {
    if (root instanceof FEl) {
        if (pred(root)) out.push(root);
        root.childNodes.forEach((c) => find(c, pred, out));
    }
    return out;
}
const byClass = (root: any, c: string) => find(root, (e) => e.classList.contains(c));
/** Objekt z jiného realmu (vm) → obyčejný, ať jde deepEqual. */
const plain = (x: any) => JSON.parse(JSON.stringify(x));
const changedBytes = (root: any) => find(root, (e) => e.classList.contains('mx-b') && e.classList.contains('chg'));
/** Všechny texty v DOM (text, title, placeholder). */
function texts(root: any, out: string[] = []): string[] {
    if (root instanceof FText) out.push(root.data);
    else if (root instanceof FEl) {
        if (root.title) out.push(root.title);
        if (root.attrs.placeholder) out.push(root.attrs.placeholder);
        root.childNodes.forEach((c) => texts(c, out));
    }
    return out;
}
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// ---- slovník a načtení pohledu (jako window.L10N z rozšíření)
function dict(area: string) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', area + '.json'), 'utf8'));
}
function translator(lang: string, areas: string[]) {
    const tx: Record<string, string> = {};
    for (const a of areas) Object.assign(tx, dict(a).en, dict(a)[lang] || {});
    return (key: string, ...args: any[]) => {
        const s = tx[key] ?? key;
        return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
    };
}
function loadViews(lang: string, files: string[]) {
    const t = translator(lang, AREAS);
    const views: Record<string, any> = {};
    const win: any = new EventTarget();
    const ctx: any = {
        document, console, btoa, CustomEvent, window: win,
        NextView: { t, lang, register: (d: any) => (views[d.id] = d) },
    };
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'media', 'views', f), 'utf8'), ctx, { filename: f });
    return { views, t, win, ctx };
}



// ---- falešný server
const SLOTS = [{ nr: 0xff, page: 0 }, { nr: 0xff, page: 1 }, { nr: 10, page: 10 }, { nr: 11, page: 11 }, { nr: 4, page: 4 }, { nr: 5, page: 5 }, { nr: 0, page: 0 }, { nr: 1, page: 1 }];
const LABELS = [
    { name: 'loop', addr: 0x8003, page: 4 },
    { name: 'start', addr: 0x8000, page: 4 },
    { name: 'loop_end', addr: 0x8005, page: 4 },
    { name: 'CAFE', addr: 0x9000, page: 4 },
    { name: 'far', addr: 0xe000, page: 20 },
    { name: 'ROM_CLS', addr: 0x0daf, page: -1 },
];
function makeServer(over: Record<string, any> = {}) {
    const nonzero = Array.from({ length: 224 }, () => 0);
    nonzero[0] = 8192;
    nonzero[4] = 4096;
    nonzero[10] = 6912;
    nonzero[20] = 1;
    const nr = new Uint8Array(256);
    nr[0x12] = 8;      // Layer 2 banka 8 → stránky 16…
    nr[0x13] = 11;     // stínová banka 11 → 22…
    nr[0x70] = 0x10;   // 320 × 256 → 80K = 10 stránek
    nr[0x69] = 0x80;
    nr[0x6b] = 0x80;   // tilemapa zapnutá
    nr[0x6e] = 0x6c;   // mapa: banka 5 + $2C00 → stránka 11
    nr[0x6f] = 0x0c;   // definice: banka 5 + $0C00 → stránka 10
    const log: any[] = [];
    const answers: Record<string, any> = {
        pageUsage: { nonzero, rom: [] },
        mmu: { slots: SLOTS },
        symbols: { labels: LABELS, codePages: { '4': 120, '20': 4 } },
        nextregs: { data: Buffer.from(nr).toString('base64') },
        ...over,
    };
    const api: any = {
        request: async (cmd: string, args: any = {}) => {
            log.push({ cmd, args });
            const a = answers[cmd];
            if (a instanceof Error) throw a;
            if (a !== undefined) return a;
            if (cmd === 'readMemory') return { data: Buffer.alloc(args.length).toString('base64') };
            throw new Error('neznámý dotaz ' + cmd);
        },
        bytes: (s: string) => new Uint8Array(Buffer.from(s || '', 'base64')),
        hex: (v: number, d?: number) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d || 2, '0'),
        el,
        highlight: () => {},
        state: { attached: true, paused: true },
    };
    return { api, log, nonzero, nr, answers };
}

async function setup(lang = 'cs', over: Record<string, any> = {}) {
    const L = loadViews(lang, ['memmap.js', 'memory.js']);
    const srv = makeServer(over);
    srv.api.t = L.t;
    srv.api.lang = lang;
    const root: any = el('div');
    L.views.memmap.mount(root, srv.api);
    await L.views.memmap.refresh(srv.api);
    const cells = () => byClass(root, 'mm-cell');
    const marks = (p: number) => cells()[p].childNodes[2].childNodes.map((m: any) => m.className);
    const hover = () => byClass(root, 'mm-hover')[0].textContent;
    const summary = () => byClass(root, 'mm-sum')[0].textContent;
    return { ...L, srv, root, cells, marks, hover, summary };
}

test('Mapa paměti: registrace (id, pořadí, přeložený název)', () => {
    const { views } = loadViews('cs', ['memmap.js']);
    assert.equal(views.memmap.id, 'memmap');
    assert.equal(views.memmap.order, 86);
    assert.equal(views.memmap.title, 'Mapa paměti');
    assert.equal(loadViews('de', ['memmap.js']).views.memmap.title, 'Speicherkarte');
});

test('Mapa paměti: obsazenost a sytost barvy', () => {
    const h = loadViews('en', ['memmap.js']).views.memmap.helpers;
    assert.equal(h.occupancy(0), 0);
    assert.equal(h.occupancy(4096), 0.5);
    assert.equal(h.occupancy(8192), 1);
    assert.equal(h.occupancy(99999), 1);
    assert.equal(h.occupancy(undefined), 0);
    assert.equal(h.shade(0), 0);
    assert.equal(h.shade(1), 80);
    assert.ok(h.shade(1 / 8192) >= 12, 'i jediný bajt je vidět');
    assert.ok(h.shade(0.25) < h.shade(0.5) && h.shade(0.5) < h.shade(1));
});

test('Mapa paměti: MMU, Layer 2 (NR $12/$13/$70), tilemapa (NR $6B/$6E/$6F), návěští', () => {
    const h = loadViews('en', ['memmap.js']).views.memmap.helpers;
    const m = h.mmuPages(SLOTS);
    assert.deepEqual([...m.keys()].sort((a: number, b: number) => a - b), [0, 1, 4, 5, 10, 11], 'ROM sloty (NR $FF) se přeskočí');
    assert.deepEqual(plain(m.get(0)), [6]);
    assert.deepEqual(plain(h.mmuPages([{ nr: 7, page: 7 }, { nr: 7, page: 7 }]).get(7)), [0, 1]);
    const nr = new Uint8Array(256);
    nr[0x12] = 9;
    nr[0x13] = 0x80 | 12;   // b7 se ignoruje
    let l2 = h.layer2Pages(nr);
    assert.deepEqual(plain(l2.active), [18, 19, 20, 21, 22, 23], '256 × 192 = 48K');
    assert.deepEqual(plain(l2.shadow), [24, 25, 26, 27, 28, 29]);
    assert.equal(l2.on, false);
    for (const mode of [1, 2, 3]) {
        nr[0x70] = mode << 4;
        l2 = h.layer2Pages(nr);
        assert.equal(l2.active.length, 10, '80K v režimu ' + mode);
        assert.equal(l2.mode, mode);
    }
    nr[0x12] = 111;   // za koncem RAM se ořízne
    assert.deepEqual(plain(h.layer2Pages(nr).active), [222, 223]);
    assert.deepEqual(plain(h.tilemapPages(nr)), [], 'tilemapa vypnutá');
    nr[0x6b] = 0x80;
    nr[0x6e] = 0x6c;
    nr[0x6f] = 0x0c;
    assert.deepEqual(plain(h.tilemapPages(nr)), [11, 10]);
    nr[0x6e] = 0x80 | 0x20;
    nr[0x6f] = 0x80 | 0x1f;
    assert.deepEqual(plain(h.tilemapPages(nr)), [15, 14], 'b7 = banka 7');
    const lp = h.labelsByPage(LABELS);
    assert.equal(lp.get(4).first.name, 'start', 'první = nejnižší adresa ve stránce');
    assert.equal(lp.get(4).count, 4);
    assert.equal(lp.get(20).first.name, 'far');
    assert.ok(!lp.has(-1));
    const a = h.analyse({ nonzero: [8192, 0, 1], rom: [200] }, { slots: SLOTS }, { codePages: { 2: 5 } }, null);
    assert.equal(a.used, 2);
    assert.equal(a.codeCount, 1);
    assert.ok(a.pages[200].marks.has('rom'));
    assert.ok(a.pages[2].marks.has('code'));
    assert.equal(a.pages[3].nonzero, 0);
    assert.equal(h.analyse(null, null, null, null).pages[3].nonzero, null, 'bez pageUsage neznámá');
});

test('Mapa paměti: mřížka 224 stránek, značky a souhrn', async () => {
    const { root, cells, marks, summary, t } = await setup('cs');
    assert.equal(cells().length, 224);
    assert.equal(summary(), [t('memmap.summary', 4, 224), t('memmap.summaryCode', 2), t('memmap.summaryMmu', '$00 $01 $04 $05 $0A $0B')].join('  ·  '));
    // obsazenost jako sytost
    assert.match(cells()[0].style.background, /charts-blue\) 80%/);
    assert.match(cells()[4].style.background, /charts-blue\) 46%/);
    assert.match(cells()[20].style.background, /charts-blue\) 12%/);
    assert.equal(cells()[5].style.background, 'transparent');
    assert.ok(cells()[5].classList.contains('empty'));
    // MMU
    assert.ok(cells()[4].classList.contains('mmu'));
    assert.equal(cells()[4].childNodes[1].textContent, 'M4');
    assert.equal(cells()[0].childNodes[1].textContent, 'M6');
    assert.ok(!cells()[2].classList.contains('mmu'));
    // značky
    assert.deepEqual(marks(4), ['mk-code']);
    assert.deepEqual(marks(10), ['mk-bank5', 'mk-tilemap']);
    assert.deepEqual(marks(11), ['mk-bank5', 'mk-tilemap']);
    assert.deepEqual(marks(14), ['mk-bank7']);
    assert.deepEqual(marks(16), ['mk-layer2']);
    assert.deepEqual(marks(22), ['mk-layer2'], 'aktivní má přednost před stínovou');
    assert.deepEqual(marks(26), ['mk-layer2s']);
    assert.deepEqual(marks(31), ['mk-layer2s']);
    assert.deepEqual(marks(32), []);
    assert.deepEqual(marks(20), ['mk-code', 'mk-layer2']);
    // legenda a záhlaví
    assert.ok(byClass(root, 'mm-legend')[0].textContent.includes(t('memmap.legendMmu')));
    assert.equal(byClass(root, 'mm-head').length, 1 + 16 + 14);
});

test('Mapa paměti: najetí ukáže stránku, banku, obsazenost, MMU, kód a návěští', async () => {
    const { cells, hover, t } = await setup('cs');
    cells()[4].dispatch('mouseenter');
    const lines = hover().split('\n');
    assert.equal(lines[0], [t('memmap.page', '$04', 4), t('memmap.bank', 2, t('memmap.lowerHalf')),
        t('memmap.usage', (4096).toLocaleString('cs'), (8192).toLocaleString('cs'), 50)].join('  ·  '));
    assert.equal(lines[1], ['MMU4 ($8000)', t('memmap.code', 120), t('memmap.labelMore', 'start', '$8000', 3)].join('  ·  '));
    assert.equal(cells()[4].title, hover());
    cells()[10].dispatch('mouseenter');
    assert.ok(hover().includes(t('memmap.ula')) && hover().includes(t('memmap.tilemap')) && hover().includes('MMU2 ($4000)'));
    cells()[17].dispatch('mouseenter');
    assert.ok(hover().includes(t('memmap.bank', 8, t('memmap.upperHalf'))) && hover().includes(t('memmap.layer2')));
    cells()[20].dispatch('mouseenter');
    assert.ok(hover().includes(t('memmap.label', 'far', '$E000')));
    cells()[100].dispatch('mouseenter');
    assert.ok(hover().endsWith(t('memmap.empty')));
});

test('Mapa paměti: klik přepne pohled Paměť na stránku (mbx-show-memory)', async () => {
    const { views, root, cells, hover, srv, win, ctx, t } = await setup('cs');
    const memRoot: any = el('div');
    views.memory.mount(memRoot, srv.api);
    const got: number[] = [];
    win.addEventListener('mbx-show-memory', (e: any) => got.push(e.detail.page));
    srv.log.length = 0;
    cells()[20].dispatch('click');
    await flush();
    assert.deepEqual(got, [20]);
    assert.equal(hover(), t('memmap.opened', '$14', 20));
    assert.equal(find(memRoot, (e) => e.tagName === 'SELECT')[0].value, 'page');
    assert.ok(srv.log.some((l) => l.cmd === 'readMemory' && l.args.page === 20), 'Paměť načetla stránku');
    // až framework umí přepnout záložku, použije se
    const shown: string[] = [];
    ctx.NextView.show = (id: string) => shown.push(id);
    cells()[3].dispatch('click');
    assert.deepEqual(shown, ['memory']);
    assert.ok(root);
});

test('Mapa paměti: bez pageUsage, bez sezení, chyba všech dotazů', async () => {
    const { cells, summary, t } = await setup('en', { pageUsage: new Error('unknown command') });
    assert.ok(summary().startsWith(t('memmap.noUsage')));
    assert.equal(cells()[0].style.background, 'transparent');
    assert.deepEqual(cells()[10].childNodes[2].childNodes.map((m: any) => m.className), ['mk-bank5', 'mk-tilemap'], 'značky i bez obsazenosti');
    const off = await setup('en');
    const api = Object.create(off.srv.api, { state: { value: { attached: false, paused: false } } });
    await off.views.memmap.refresh(api);
    assert.equal(off.summary(), 'No debug session.');
    const bad = Object.create(off.srv.api, { request: { value: async () => { throw new Error('boom'); } } });
    await assert.rejects(off.views.memmap.refresh(bad), /boom/);
});

for (const lang of ['en', 'cs', 'de']) {
    test('Mapa paměti: všechny texty přeložené (' + lang + ')', async () => {
        const { root, cells, views } = await setup(lang, { pageUsage: { nonzero: Array.from({ length: 224 }, (_, i) => (i % 3 ? 0 : i * 30)), rom: [222] } });
        const all: string[] = [];
        for (const p of [0, 1, 4, 10, 11, 14, 15, 16, 22, 26, 100, 222]) {
            cells()[p].dispatch('mouseenter');
            texts(root, all);
        }
        byClass(root, 'mm-grid')[0].dispatch('mouseleave');
        texts(root, all);
        cells()[7].dispatch('click');
        texts(root, all);
        all.push(views.memmap.title);
        assert.deepEqual([...new Set(all.filter((s) => /\bmemmap\.[a-zA-Z]/.test(s)))], [], 'klíč bez překladu');
        if (lang !== 'cs') assert.deepEqual([...new Set(all.filter((s) => /[ěščřžůňťďĚŠČŘŽŮŇŤĎ]/.test(s)))], [], 'čeština v ' + lang);
        // vypnutá Layer 2
        const s2 = await setup(lang);
        s2.srv.nr[0x69] = 0;
        s2.srv.answers.nextregs = { data: Buffer.from(s2.srv.nr).toString('base64') };
        await s2.views.memmap.refresh(s2.srv.api);
        s2.cells()[16].dispatch('mouseenter');
        assert.ok(s2.hover().includes(s2.t('memmap.layer2Off')));
    });
}

test('Mapa paměti: slovník – stejné klíče ve 13 jazycích, jen předpona memmap., stejné parametry', () => {
    const d = dict('memmap');
    assert.deepEqual(Object.keys(d).sort(), [...LANGS].sort());
    const en = Object.keys(d.en).sort();
    const params = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
    for (const l of LANGS) {
        assert.deepEqual(Object.keys(d[l]).sort(), en, 'klíče ' + l);
        for (const k of en) {
            assert.ok(k.startsWith('memmap.'), k);
            assert.ok(d[l][k].trim(), 'prázdný ' + l + ' ' + k);
            assert.equal(params(d[l][k]), params(d.en[k]), 'parametry ' + l + ' ' + k);
        }
    }
    const src = fs.readFileSync(path.join(ROOT, 'media', 'views', 'memmap.js'), 'utf8');
    for (const m of src.matchAll(/'(memmap\.[A-Za-z0-9.]+)'/g)) assert.ok(m[1] in d.en, 'chybí ' + m[1]);
});
