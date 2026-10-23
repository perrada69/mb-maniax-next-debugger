// Pohled Paměť (media/views/memory.js) nad podvrženým DOM a falešným serverem podle docs/next-views.md:
// rozbor adres a návěští, mapování MMU, virtualizace řádků, zvýraznění změn, writeMemory jen v pauze,
// přepnutí z mapy paměti (událost mbx-show-memory), překlady.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'cs', 'sk', 'es', 'de', 'fr', 'it', 'pl', 'pt-br', 'ru', 'uk', 'ja', 'zh-cn'];

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
    const t = translator(lang, ['memory', 'memmap']);
    const views: Record<string, any> = {};
    const win: any = new EventTarget();
    const ctx: any = {
        document, console, btoa, CustomEvent, window: win,
        NextView: { t, lang, register: (d: any) => (views[d.id] = d) },
    };
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'media', 'views', f), 'utf8'), ctx, { filename: f });
    return { views, t, win };
}

// ---- falešný server: fyzická RAM 224 × 8K, ROM 16K, MMU, SLD
const SLOTS = [{ nr: 0xff, page: 0 }, { nr: 0xff, page: 1 }, { nr: 10, page: 10 }, { nr: 11, page: 11 }, { nr: 4, page: 4 }, { nr: 5, page: 5 }, { nr: 0, page: 0 }, { nr: 1, page: 1 }];
const LABELS = [
    { name: 'start', addr: 0x8000, page: 4 },
    { name: 'loop', addr: 0x8003, page: 4 },
    { name: 'loop_end', addr: 0x8005, page: 4 },
    { name: 'tbl', addr: 0xc010, page: 0 },
    { name: 'far', addr: 0xe000, page: 20 },
    { name: 'ROM_CLS', addr: 0x0daf, page: -1 },
    { name: 'CAFE', addr: 0x9000, page: 4 },
];
function makeServer(state: any) {
    const phys = new Uint8Array(224 * 0x2000);
    const rom = new Uint8Array(0x4000);
    for (let i = 0; i < rom.length; i++) rom[i] = 0xf3;
    for (let i = 0; i < 0x2000; i++) phys[4 * 0x2000 + i] = (i * 7) & 0xff;
    phys.set(Buffer.from('HELLO'), 4 * 0x2000 + 0x10);
    phys[20 * 0x2000 + 0x100] = 0x42;
    const log: any[] = [];
    const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64');
    const cpu = () => {
        const out = new Uint8Array(0x10000);
        for (let s = 0; s < 8; s++) {
            const sl = SLOTS[s];
            const src = sl.nr === 0xff ? rom.subarray(sl.page * 0x2000, sl.page * 0x2000 + 0x2000) : phys.subarray(sl.page * 0x2000, sl.page * 0x2000 + 0x2000);
            out.set(src, s * 0x2000);
        }
        return out;
    };
    const api: any = {
        request: async (cmd: string, args: any = {}) => {
            log.push({ cmd, args });
            switch (cmd) {
                case 'readMemory':
                    if (typeof args.page === 'number') {
                        if (args.page >= 0xe0) throw new Error('invalid_page');
                        const o = args.page * 0x2000 + args.addr;
                        return { data: b64(phys.subarray(o, o + args.length)) };
                    }
                    return { data: b64(cpu().subarray(args.addr, args.addr + args.length)) };
                case 'writeMemory': {
                    const d = Buffer.from(args.data, 'base64');
                    if (typeof args.page === 'number') phys.set(d, args.page * 0x2000 + args.addr);
                    else {
                        const s = SLOTS[args.addr >> 13];
                        if (s.nr === 0xff) throw new Error('read_only');
                        phys.set(d, s.page * 0x2000 + (args.addr & 0x1fff));
                    }
                    return { written: d.length };
                }
                case 'mmu':
                    return { slots: SLOTS };
                case 'symbols':
                    return { labels: LABELS, codePages: { '4': 120, '20': 4 } };
                case 'pageUsage':
                    return { nonzero: Array.from({ length: 224 }, () => 0), rom: [] };
            }
            throw new Error('neznámý dotaz ' + cmd);
        },
        bytes: (s: string) => new Uint8Array(Buffer.from(s || '', 'base64')),
        hex: (v: number, d?: number) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d || 2, '0'),
        el,
        highlight: () => {},
        lang: 'cs',
    };
    Object.defineProperty(api, 'state', { get: () => ({ attached: true, paused: state.paused }) });
    return { api, phys, log };
}

async function setup(lang = 'cs') {
    const { views, t, win } = loadViews(lang, ['memory.js']);
    const state = { paused: true };
    const srv = makeServer(state);
    srv.api.t = t;
    srv.api.lang = lang;
    const root: any = el('div');
    const v = views.memory;
    v.mount(root, srv.api);
    const view = byClass(root, 'mx-view')[0];
    view.clientHeight = 20 * v.helpers.ROW_H;   // 20 viditelných řádků
    await v.refresh(srv.api);
    const rows = () => byClass(root, 'mx-row').filter((r) => !r.hidden);
    const rowText = (r: any) => r.childNodes.map((c: any) => c.textContent);
    const rowAt = (addrText: string) => rows().find((r) => r.childNodes[0].textContent === addrText);
    return { v, t, win, state, srv, root, view, rows, rowText, rowAt };
}

test('Paměť: registrace (id, pořadí, přeložený název)', () => {
    const { views } = loadViews('cs', ['memory.js']);
    assert.equal(views.memory.id, 'memory');
    assert.equal(views.memory.order, 85);
    assert.equal(views.memory.title, 'Paměť');
    assert.equal(loadViews('de', ['memory.js']).views.memory.title, 'Speicher');
});

test('Paměť: čísla a bajty', () => {
    const h = loadViews('en', ['memory.js']).views.memory.helpers;
    assert.equal(h.parseNumber('32768'), 32768);
    assert.equal(h.parseNumber('$8000'), 0x8000);
    assert.equal(h.parseNumber('0x1F'), 0x1f);
    assert.equal(h.parseNumber('#ff'), 0xff);
    assert.equal(h.parseNumber('0C000h'), 0xc000);
    assert.equal(h.parseNumber('C000'), 0xc000);
    assert.equal(h.parseNumber('start'), null);
    assert.equal(h.parseByte('ab'), 0xab);
    assert.equal(h.parseByte('$7'), 7);
    assert.equal(h.parseByte('100'), null);
    assert.equal(h.parseByte('xy'), null);
});

test('Paměť: zadání adresy – číslo, stránka:posun, návěští podle MMU', () => {
    const h = loadViews('en', ['memory.js']).views.memory.helpers;
    const cpu = { labels: LABELS, space: 'cpu', page: 0, slots: SLOTS };
    assert.deepEqual(plain(h.parseAddress('$8000', cpu)), { space: 'cpu', addr: 0x8000 });
    assert.deepEqual(plain(h.parseAddress('49152', cpu)), { space: 'cpu', addr: 49152 });
    assert.deepEqual(plain(h.parseAddress('$0A:$0100', cpu)), { space: 'page', page: 10, addr: 0x100 });
    assert.equal(h.parseAddress('$E0:0', cpu), null, 'stránka mimo 0–223');
    assert.equal(h.parseAddress('$10000', cpu), null);
    assert.deepEqual(plain(h.parseAddress('START', cpu)), { space: 'cpu', addr: 0x8000 }, 'bez ohledu na velikost písmen');
    assert.deepEqual(plain(h.parseAddress('CAFE', cpu)), { space: 'cpu', addr: 0x9000 }, 'návěští má přednost před hex bez předpony');
    assert.deepEqual(plain(h.parseAddress('$CAFE', cpu)), { space: 'cpu', addr: 0xcafe });
    assert.deepEqual(plain(h.parseAddress('tbl', cpu)), { space: 'cpu', addr: 0xc010 }, 'stránka 0 je v MMU6');
    assert.deepEqual(plain(h.parseAddress('far', cpu)), { space: 'page', page: 20, addr: 0 }, 'nenamapovaná stránka → fyzicky');
    assert.deepEqual(plain(h.parseAddress('ROM_CLS', cpu)), { space: 'cpu', addr: 0x0daf });
    assert.equal(h.parseAddress('neni', cpu), null);
    // stránka namapovaná jinde, než říká adresa návěští
    assert.deepEqual(plain(h.parseAddress('x', { ...cpu, labels: [{ name: 'x', addr: 0x4005, page: 4 }] })), { space: 'cpu', addr: 0x8005 });
    const pg = { labels: LABELS, space: 'page', page: 4, slots: SLOTS };
    assert.deepEqual(plain(h.parseAddress('$100', pg)), { space: 'page', page: 4, addr: 0x100 });
    assert.equal(h.parseAddress('$2000', pg), null, 'posun mimo stránku');
    assert.deepEqual(plain(h.parseAddress('loop', pg)), { space: 'page', page: 4, addr: 3 });
});

test('Paměť: návěští v prostoru CPU i stránky, oblasti ROM a kódu', () => {
    const h = loadViews('en', ['memory.js']).views.memory.helpers;
    const placed = h.placeLabels(LABELS, 'cpu', 0, SLOTS);
    const at = Object.fromEntries(placed.map((p: any) => [p.name, p.at]));
    assert.equal(at.start, 0x8000);
    assert.equal(at.tbl, 0xc010);
    assert.equal(at.ROM_CLS, 0x0daf);
    assert.ok(!('far' in at), 'stránka 20 není v MMU');
    assert.deepEqual(plain(placed.map((p: any) => p.at)), [...placed.map((p: any) => p.at)].sort((a, b) => a - b));
    assert.equal(placed[h.labelBefore(placed, 0x8004)].name, 'loop');
    assert.equal(h.labelBefore(placed, 0x0100), -1);
    const inPage = h.placeLabels(LABELS, 'page', 20, SLOTS);
    assert.deepEqual(plain(inPage), [{ at: 0, name: 'far' }]);
    assert.equal(h.slotPage(SLOTS, 0), -1);
    assert.equal(h.slotPage(SLOTS, 4), 4);
    const code = { 4: 120 };
    assert.equal(h.regionOf('cpu', 0, SLOTS, code, null, 0x0100), 'rom');
    assert.equal(h.regionOf('cpu', 0, SLOTS, code, null, 0x8100), 'code');
    assert.equal(h.regionOf('cpu', 0, SLOTS, code, null, 0xa000), '');
    assert.equal(h.regionOf('page', 4, SLOTS, code, new Set([7]), 0), 'code');
    assert.equal(h.regionOf('page', 7, SLOTS, code, new Set([7]), 0), 'rom');
    assert.deepEqual(plain(h.suggest(LABELS, 'lo', 10)), ['loop', 'loop_end']);
    assert.deepEqual(plain(h.suggest(LABELS, 'end', 10)), ['loop_end']);
    assert.equal(h.suggest(LABELS, '', 3).length, 3);
});

test('Paměť: virtualizace – 64K = 4096 řádků, vykreslí se jen viditelné', async () => {
    const { v, view, rows, rowText, root } = await setup();
    const h = v.helpers;
    const spacer = byClass(root, 'mx-spacer')[0];
    assert.equal(spacer.style.height, 4096 * h.ROW_H + 'px');
    const max = 20 + 2 * h.OVERSCAN;
    assert.ok(rows().length <= max, 'vykresleno ' + rows().length);
    assert.equal(rows()[0].childNodes[0].textContent, '0000');
    const pool = byClass(root, 'mx-row').length;
    assert.ok(pool <= h.FALLBACK_ROWS + 2 * h.OVERSCAN, 'řádků DOM ' + pool);
    // posun na konec: poslední řádek FFF0, počet řádků DOM se nezvětší
    view.scrollTop = 4096 * h.ROW_H - view.clientHeight;
    view.dispatch('scroll');
    const last = rows()[rows().length - 1];
    assert.equal(last.childNodes[0].textContent, 'FFF0');
    assert.equal(byClass(root, 'mx-row').length, pool, 'řádky DOM se znovu používají');
    // doprostřed
    view.scrollTop = 0x8000 / 16 * h.ROW_H;
    view.dispatch('scroll');
    const r = rows().find((x) => x.childNodes[0].textContent === '8010');
    assert.ok(r, 'řádek $8010 vykreslený');
    const cells = rowText(r);
    assert.equal(cells.length, 2 + 16 + 1);
    assert.equal(cells[1], '');
    // stránka 4 + $10 = "HELLO"
    assert.deepEqual(cells.slice(2, 7), ['48', '45', '4C', '4C', '4F']);
    assert.ok(cells[18].startsWith('HELLO'));
    // řádek $8000: návěští start (+2 další v řádku), podtržené bajty, oblast kódu
    const r0 = rows().find((x) => x.childNodes[0].textContent === '8000');
    assert.equal(r0.childNodes[1].textContent, 'start +2');
    assert.equal(r0.childNodes[1].title, 'start\nloop\nloop_end');
    assert.ok(r0.childNodes[2].classList.contains('lbl') && r0.childNodes[5].classList.contains('lbl') && !r0.childNodes[3].classList.contains('lbl'));
    assert.ok(r0.childNodes[0].classList.contains('code'));
    assert.ok(r0.classList.contains('slot'), 'začátek slotu MMU');
    view.scrollTop = 0;
    view.dispatch('scroll');
    assert.ok(rows()[0].childNodes[0].classList.contains('rom'));
    assert.equal(rows()[0].childNodes[2].textContent, 'F3');
});

test('Paměť: zvýraznění bajtů změněných od minulého obnovení', async () => {
    const { v, srv, rows, root, view } = await setup();
    assert.equal(changedBytes(root).length, 0, 'po prvním načtení nic');
    srv.phys[0 * 0x2000 + 0x0005] = 0x99;   // stránka 0 = MMU6 → $C005
    await v.refresh(srv.api);
    // přesun na $C000
    view.scrollTop = 0xc000 / 16 * v.helpers.ROW_H;
    view.dispatch('scroll');
    const r = rows().find((x) => x.childNodes[0].textContent === 'C000');
    const chg = changedBytes(r);
    assert.equal(chg.length, 1);
    assert.equal(chg[0].textContent, '99');
    assert.equal(chg[0], r.childNodes[2 + 5]);
    await v.refresh(srv.api);
    assert.equal(changedBytes(r).length, 0, 'bez další změny zvýraznění zmizí');
});

test('Paměť: skok na návěští a adresu, našeptávač', async () => {
    const { v, root, view, rows, srv } = await setup();
    const input = find(root, (e) => e.tagName === 'INPUT' && e.attrs.type === 'text')[0];
    const list = find(root, (e) => e.tagName === 'DATALIST')[0];
    assert.equal(input.attrs.list, list.id);
    input.value = 'lo';
    input.dispatch('input', { inputType: 'insertText' });
    assert.deepEqual(list.childNodes.map((o: any) => o.attrs.value), ['loop', 'loop_end']);
    input.value = 'loop';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.equal(view.scrollTop, (0x8000 / 16 - 1) * v.helpers.ROW_H);
    const cur = byClass(root, 'cur');
    assert.equal(cur.length, 1);
    assert.equal(cur[0].parentNode.childNodes[0].textContent, '8000');
    assert.equal(cur[0], cur[0].parentNode.childNodes[2 + 3]);
    // výběr z našeptávače skočí hned
    input.value = 'tbl';
    input.dispatch('input', { inputType: 'insertReplacementText' });
    await flush();
    assert.ok(rows().some((r) => r.childNodes[0].textContent === 'C010'));
    // návěští v nenamapované stránce přepne na fyzickou stránku
    srv.log.length = 0;
    input.value = 'far';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();
    const sel = find(root, (e) => e.tagName === 'SELECT')[0];
    assert.equal(sel.value, 'page');
    assert.ok(srv.log.some((l) => l.cmd === 'readMemory' && l.args.page === 20 && l.args.length === 0x2000));
    const r = rows().find((x) => x.childNodes[0].textContent === '14:0000');
    assert.equal(r.childNodes[1].textContent, 'far');
    // neznámé
    input.value = 'neexistuje';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.equal(byClass(root, 'mx-msg')[0].textContent, 'Neznámá adresa nebo návěští: neexistuje');
});

test('Paměť: úprava bajtu dvojklikem jen v pauze → writeMemory', async () => {
    const { root, rows, srv, state, v } = await setup();
    const byte = (addr: string, j: number) => rows().find((x) => x.childNodes[0].textContent === addr).childNodes[2 + j];
    const msg = () => byClass(root, 'mx-msg')[0];
    // za běhu: žádný zápis, upozornění
    state.paused = false;
    byte('0000', 1).dispatch('dblclick');
    assert.equal(find(root, (e) => e.tagName === 'INPUT' && e.parentNode && e.parentNode.classList.contains('mx-b')).length, 0);
    assert.ok(msg().classList.contains('warn'));
    assert.equal(msg().textContent, 'Paměť lze upravovat jen při zastaveném stroji.');
    assert.ok(!srv.log.some((l) => l.cmd === 'writeMemory'));
    // v pauze: editor v buňce, Enter zapíše
    state.paused = true;
    const view = byClass(root, 'mx-view')[0];
    view.scrollTop = 0x8000 / 16 * v.helpers.ROW_H;
    view.dispatch('scroll');
    byte('8010', 2).dispatch('dblclick');
    const ed = find(root, (e) => e.tagName === 'INPUT' && e.parentNode && e.parentNode.classList.contains('mx-b'))[0];
    assert.ok(ed, 'editor v buňce');
    assert.equal(ed.value, '4C');
    ed.value = 'zz';
    ed.dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.equal(msg().textContent, 'Zadejte bajt v hex (00–FF); Esc zruší.');
    ed.value = 'ab';
    ed.dispatch('keydown', { key: 'Enter' });
    await flush();
    const w = srv.log.filter((l) => l.cmd === 'writeMemory');
    assert.equal(w.length, 1);
    assert.deepEqual(plain(w[0].args), { addr: 0x8012, data: Buffer.from([0xab]).toString('base64') });
    assert.equal(srv.phys[4 * 0x2000 + 0x12], 0xab);
    assert.equal(byte('8010', 2).textContent, 'AB');
    assert.ok(byte('8010', 2).classList.contains('chg'));
    assert.equal(msg().textContent, 'Zapsáno $8012 = $AB');
    // stroj se rozběhl během úprav → nezapíše
    byte('8010', 3).dispatch('dblclick');
    state.paused = false;
    const ed2 = find(root, (e) => e.tagName === 'INPUT' && e.parentNode && e.parentNode.classList.contains('mx-b'))[0];
    ed2.value = '00';
    ed2.dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.equal(srv.log.filter((l) => l.cmd === 'writeMemory').length, 1);
    // ROM → chyba serveru
    state.paused = true;
    view.scrollTop = 0;
    view.dispatch('scroll');
    byte('0000', 0).dispatch('dblclick');
    find(root, (e) => e.tagName === 'INPUT' && e.parentNode && e.parentNode.classList.contains('mx-b'))[0].dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.equal(msg().textContent, 'Zápis selhal: read_only');
    // fyzická stránka: zápis s page
    const sel = find(root, (e) => e.tagName === 'SELECT')[0];
    sel.value = 'page';
    sel.dispatch('change');
    const pageIn = find(root, (e) => e.tagName === 'INPUT' && e.attrs.type === 'number')[0];
    pageIn.value = '20';
    pageIn.dispatch('change');
    await flush();
    view.scrollTop = 0x100 / 16 * v.helpers.ROW_H;
    view.dispatch('scroll');
    byte('14:0100', 0).dispatch('dblclick');
    const ed3 = find(root, (e) => e.tagName === 'INPUT' && e.parentNode && e.parentNode.classList.contains('mx-b'))[0];
    assert.equal(ed3.value, '42');
    ed3.value = '7';
    ed3.dispatch('keydown', { key: 'Enter' });
    await flush();
    const w2 = srv.log.filter((l) => l.cmd === 'writeMemory').pop();
    assert.deepEqual(plain(w2.args), { addr: 0x100, data: Buffer.from([7]).toString('base64'), page: 20 });
    assert.equal(srv.phys[20 * 0x2000 + 0x100], 7);
});

test('Paměť: stránka z mapy paměti (mbx-show-memory), i před prvním zobrazením', async () => {
    const { views, t, win } = loadViews('cs', ['memory.js']);
    const state = { paused: true };
    const srv = makeServer(state);
    srv.api.t = t;
    // událost přijde dřív, než se záložka poprvé zobrazí
    win.dispatchEvent(new CustomEvent('mbx-show-memory', { detail: { page: 20 } }));
    const root: any = el('div');
    views.memory.mount(root, srv.api);
    await views.memory.refresh(srv.api);
    const sel = find(root, (e) => e.tagName === 'SELECT')[0];
    assert.equal(sel.value, 'page');
    assert.ok(srv.log.some((l) => l.cmd === 'readMemory' && l.args.page === 20));
    assert.match(byClass(root, 'mx-info')[0].textContent, /^Stránka 20 \(\$14\) · 16K banka 10, posun \$0000/);
    // po zobrazení: přepne a sám načte
    srv.log.length = 0;
    win.dispatchEvent(new CustomEvent('mbx-show-memory', { detail: { page: 4 } }));
    await flush();
    assert.ok(srv.log.some((l) => l.cmd === 'readMemory' && l.args.page === 4));
    assert.equal(find(root, (e) => e.tagName === 'INPUT' && e.attrs.type === 'number')[0].value, '4');
    win.dispatchEvent(new CustomEvent('mbx-show-memory', { detail: { page: 300 } }));
    await flush();
    assert.equal(find(root, (e) => e.tagName === 'INPUT' && e.attrs.type === 'number')[0].value, '4', 'neplatná stránka se ignoruje');
});

test('Paměť: bez sezení a při chybě čtení', async () => {
    const { views, t } = loadViews('en', ['memory.js']);
    const srv = makeServer({ paused: true });
    srv.api.t = t;
    const api = Object.create(srv.api, { state: { get: () => ({ attached: false, paused: false }) } });
    const root: any = el('div');
    views.memory.mount(root, api);
    await views.memory.refresh(api);
    assert.equal(byClass(root, 'mx-info')[0].textContent, 'No debug session.');
    const bad = Object.create(srv.api, { request: { value: async () => { throw new Error('boom'); } } });
    await assert.rejects(views.memory.refresh(bad), /boom/);
});

for (const lang of ['en', 'cs', 'de']) {
    test('Paměť: všechny texty přeložené (' + lang + ')', async () => {
        const { root, state, rows, v, srv } = await setup(lang);
        const all: string[] = [];
        texts(root, all);
        // stavy: výběr bajtu (title), upozornění za běhu, chyba adresy, stránka
        const b = rows()[0].childNodes[2];
        b.dispatch('mouseover');
        b.dispatch('click');
        state.paused = false;
        b.dispatch('dblclick');
        texts(root, all);
        const input = find(root, (e) => e.tagName === 'INPUT' && e.attrs.type === 'text')[0];
        input.value = '???';
        input.dispatch('keydown', { key: 'Enter' });
        await flush();
        texts(root, all);
        const sel = find(root, (e) => e.tagName === 'SELECT')[0];
        sel.value = 'page';
        sel.dispatch('change');
        await flush();
        srv.phys[3] = 1;
        await v.refresh(srv.api);
        texts(root, all);
        all.push(v.title);
        const keys = [...new Set(all.filter((s) => /\bmemory\.[a-zA-Z]/.test(s)))];
        assert.deepEqual(keys, [], 'klíč bez překladu');
        if (lang !== 'cs') assert.deepEqual([...new Set(all.filter((s) => /[ěščřžůňťďĚŠČŘŽŮŇŤĎ]/.test(s)))], [], 'čeština v ' + lang);
        assert.ok(all.length > 50);
    });
}

test('Paměť: slovník – stejné klíče ve 13 jazycích, jen předpona memory., stejné parametry', () => {
    const d = dict('memory');
    assert.deepEqual(Object.keys(d).sort(), [...LANGS].sort());
    const en = Object.keys(d.en).sort();
    const params = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
    for (const l of LANGS) {
        assert.deepEqual(Object.keys(d[l]).sort(), en, 'klíče ' + l);
        for (const k of en) {
            assert.ok(k.startsWith('memory.'), k);
            assert.ok(d[l][k].trim(), 'prázdný ' + l + ' ' + k);
            assert.equal(params(d[l][k]), params(d.en[k]), 'parametry ' + l + ' ' + k);
        }
    }
    // každý klíč použitý ve zdroji je ve slovníku
    const src = fs.readFileSync(path.join(ROOT, 'media', 'views', 'memory.js'), 'utf8');
    for (const m of src.matchAll(/'(memory\.[A-Za-z0-9.]+)'/g)) assert.ok(m[1] in d.en, 'chybí ' + m[1]);
});
