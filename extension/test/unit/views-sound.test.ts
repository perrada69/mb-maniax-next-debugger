// Pohled Zvuk (media/views/sound.js) nad podvrženým DOM a falešným serverem podle docs/next-views.md:
// perioda → Hz a nota (takt AY 1,75 MHz), tvary obálky, mixer, hlasitost, registry, DAC, obnovování Živě, překlady.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'cs', 'sk', 'es', 'de', 'fr', 'it', 'pl', 'pt-br', 'ru', 'uk', 'ja', 'zh-cn'];
const AREAS = ['sound'];

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


// ---- falešný server: soundState podle smlouvy
function regsChip0() {
    const r = new Array(16).fill(0);
    r[0] = 249;          // A: 1,75 MHz / (16 · 249) = 439,26 Hz → A4 −3 ¢
    r[2] = 418 & 0xff;   // B: 418 → 261,66 Hz → C4
    r[3] = 418 >> 8;
    r[4] = 0;            // C: perioda 0 = 1 → 109 375 Hz
    r[6] = 0x1f;         // šum 31 → 3 528 Hz
    r[7] = 0x36;         // tón A zapnutý, B/C vypnuté; šum A zapnutý, B/C vypnuté
    r[8] = 0x0f;
    r[9] = 0x10;         // obálka
    r[10] = 0x07;
    r[11] = 0x00;
    r[12] = 0x01;        // obálka 256 → 26,70 Hz
    r[13] = 0x0e;        // /\/\
    return r;
}
function makeServer() {
    const res: any = {
        chips: [{ regs: regsChip0() }, { regs: new Array(16).fill(0) }, { regs: Array.from({ length: 16 }, (_, i) => i * 3) }],
        turbosound: false,
        ayMode: 'YM',
        dac: [0x80, 0, 0xff, 0x40],
    };
    const log: any[] = [];
    const api: any = {
        request: async (cmd: string) => {
            log.push(cmd);
            if (cmd === 'soundState') return JSON.parse(JSON.stringify(res));
            throw new Error('neznámý dotaz ' + cmd);
        },
        bytes: (s: string) => new Uint8Array(Buffer.from(s || '', 'base64')),
        hex: (v: number, d?: number) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d || 2, '0'),
        el,
        highlight: () => {},
        state: { attached: true, paused: false },
    };
    return { api, res, log };
}

async function setup(lang = 'cs') {
    const L = loadViews(lang, ['sound.js']);
    const srv = makeServer();
    srv.api.t = L.t;
    srv.api.lang = lang;
    const root: any = el('div');
    L.views.sound.mount(root, srv.api);
    await L.views.sound.refresh(srv.api);
    const chips = () => byClass(root, 'sd-chip');
    const chRows = (i: number) => find(chips()[i], (e) => e.tagName === 'TR' && e.parentNode.tagName === 'TBODY' && e.parentNode.parentNode.classList.contains('table') && !e.parentNode.parentNode.classList.contains('sd-regs'));
    const regCells = (i: number) => find(byClass(chips()[i], 'sd-regs')[0], (e) => e.tagName === 'TD');
    const cellText = (tr: any) => tr.childNodes.map((c: any) => c.textContent);
    const fmt = (v: number, d: number) => v.toLocaleString(lang, { minimumFractionDigits: d, maximumFractionDigits: d });
    return { ...L, srv, root, chips, chRows, regCells, cellText, fmt };
}

test('Zvuk: registrace (id, pořadí, přeložený název)', () => {
    const { views } = loadViews('cs', ['sound.js']);
    assert.equal(views.sound.id, 'sound');
    assert.equal(views.sound.order, 87);
    assert.equal(views.sound.title, 'Zvuk');
    assert.equal(loadViews('en', ['sound.js']).views.sound.title, 'Sound');
});

test('Zvuk: perioda → frekvence a nota (takt AY 1,75 MHz)', () => {
    const h = loadViews('en', ['sound.js']).views.sound.helpers;
    assert.equal(h.AY_CLOCK, 1750000);
    assert.equal(h.toneHz(1), 109375);
    assert.equal(h.toneHz(0), 109375, 'perioda 0 se chová jako 1');
    assert.ok(Math.abs(h.toneHz(249) - 439.257) < 0.001);
    assert.ok(Math.abs(h.toneHz(4095) - 26.709) < 0.001);
    assert.deepEqual(plain(h.noteOf(440)), { midi: 69, index: 9, octave: 4, cents: 0 });
    assert.deepEqual(plain(h.noteOf(h.toneHz(249))), { midi: 69, index: 9, octave: 4, cents: -3 });
    assert.deepEqual(plain(h.noteOf(261.63)), { midi: 60, index: 0, octave: 4, cents: 0 });
    assert.deepEqual(plain(h.noteOf(27.5)), { midi: 21, index: 9, octave: 0, cents: 0 });
    assert.equal(h.noteOf(16.35).octave, 0);
    assert.equal(h.noteOf(16.35).index, 0);
    assert.equal(h.noteOf(0), null);
    const names = 'C,C♯,D,D♯,E,F,F♯,G,G♯,A,A♯,B'.split(',');
    assert.equal(h.noteName(h.noteOf(466.16), names), 'A♯4');
    assert.equal(h.noteName(h.noteOf(h.toneHz(221)), names), 'B4');
    assert.ok(Math.abs(h.noiseHz(31) - 3528.226) < 0.001);
    assert.equal(h.noiseHz(0), 109375);
    assert.equal(h.noiseHz(0x21), 109375, 'šum má jen 5 bitů');
    assert.ok(Math.abs(h.envHz(256) - 26.7029) < 0.001);
    assert.equal(h.envHz(0), 1750000 / 256);
    assert.equal(h.envHz(0), h.envHz(1));
    assert.equal(h.tonePeriod([0xff, 0xff, 0, 0, 0, 0], 0), 0xfff, 'perioda tónu 12 bitů');
});

test('Zvuk: tvary obálky R13 (CONT ATT ALT HOLD)', () => {
    const h = loadViews('en', ['sound.js']).views.sound.helpers;
    const keys = Array.from({ length: 16 }, (_, s) => h.envShape(s).key);
    assert.deepEqual(keys, ['decay', 'decay', 'decay', 'decay', 'attack', 'attack', 'attack', 'attack',
        'sawDown', 'decay', 'triDown', 'decayHold', 'sawUp', 'attackHold', 'triUp', 'attack']);
    assert.equal(h.envShape(0x1e).shape, 14, 'jen b3:0');
    assert.equal(h.envShape(8).glyph, '\\\\\\\\');
    assert.equal(h.envShape(10).glyph, '\\/\\/');
    assert.equal(h.envShape(13).glyph, '/‾‾‾');
});

test('Zvuk: dekódování čipu – mixer, hlasitost, obálka, šum', () => {
    const h = loadViews('en', ['sound.js']).views.sound.helpers;
    const d = h.decodeChip(regsChip0());
    assert.deepEqual(plain(d.channels.map((c: any) => [c.period, c.tone, c.noise, c.volume, c.env])),
        [[249, true, true, 15, false], [418, false, false, 0, true], [0, false, false, 7, false]]);
    assert.equal(d.channels[1].note.midi, 60);
    assert.deepEqual(plain({ ...d.noise }), { period: 31, hz: 1750000 / (16 * 31) });
    assert.equal(d.env.period, 256);
    assert.equal(d.env.key, 'triUp');
    assert.equal(d.mixer, 0x36);
    const z = h.decodeChip(undefined);
    assert.equal(z.regs.length, 16);
    assert.ok(z.channels.every((c: any) => c.tone && c.noise && c.volume === 0), 'R7 = 0: vše zapnuté');
});

test('Zvuk: tabulka kanálů, šum, obálka, registry, DAC', async () => {
    const { chips, chRows, regCells, cellText, root, t, fmt } = await setup('cs');
    assert.equal(chips().length, 3);
    const [a, b, c] = chRows(0).map(cellText);
    assert.deepEqual(a.slice(0, 4), ['A', '$0F9 249', fmt(439.257, 1) + ' Hz', 'A4 -3¢']);
    assert.deepEqual(b.slice(0, 4), ['B', '$1A2 418', fmt(261.663, 1) + ' Hz', 'C4']);
    assert.equal(c[2], fmt(109375, 0) + ' Hz');
    assert.equal(a[4].trim(), '15');
    assert.equal(b[4].trim(), t('sound.envelope'));
    assert.deepEqual([a[5], a[6], b[5], b[6], c[5], c[6]], [t('sound.on'), t('sound.on'), '–', '–', '–', '–']);
    const bars = byClass(chips()[0], 'sd-bar');
    assert.deepEqual(bars.map((x: any) => x.childNodes[0].style.width), ['100%', '100%', '47%']);
    assert.ok(bars[1].classList.contains('env') && !bars[0].classList.contains('env'));
    const lines = byClass(chips()[0], 'sd-line').map((x: any) => x.textContent);
    assert.equal(lines[0], t('sound.noiseLine', '$1F', 31, fmt(3528.226, 0) + ' Hz', '$36'));
    assert.equal(lines[1], t('sound.envLine', '$0100', 256, fmt(26.703, 2) + ' Hz', '$E', '/\\/\\', t('sound.env.triUp')));
    assert.deepEqual(regCells(0).map((x: any) => x.textContent), ['F9', '00', 'A2', '01', '00', '00', '1F', '36', '0F', '10', '07', '00', '01', '0E', '00', '00']);
    assert.equal(regCells(2)[5].textContent, '0F');
    // bez TurboSound tiká jen AY #0
    assert.ok(!chips()[0].classList.contains('idle'));
    assert.ok(chips()[1].classList.contains('idle') && chips()[2].classList.contains('idle'));
    assert.equal(byClass(chips()[1], 'sd-badge')[0].textContent, t('sound.idle'));
    assert.equal(byClass(root, 'sd-info')[0].textContent, [t('sound.mode', 'YM'), t('sound.turboOff'), t('sound.clock', fmt(1.75, 2) + ' MHz')].join('  ·  '));
    // DAC jako sloupce
    const cols = byClass(root, 'sd-colbar').map((x: any) => x.childNodes[0].style.height);
    assert.deepEqual(cols, ['50%', '0%', '100%', '25%']);
    assert.deepEqual(byClass(root, 'sd-col').map((x: any) => x.childNodes[1].textContent), ['80', '00', 'FF', '40']);
    assert.equal(byClass(root, 'sd-dac')[0].hidden, false);
});

test('Zvuk: Živě – obnovení přepisuje tytéž prvky, změny registrů zvýrazní, aktivní čip', async () => {
    const { srv, views, root, chips, chRows, regCells, t } = await setup('cs');
    const count = find(root, () => true).length;
    const cell = chRows(0)[0].childNodes[1];
    srv.res.chips[0].regs[8] = 5;
    srv.res.chips[0].regs[0] = 100;
    srv.res.turbosound = true;
    srv.res.active = 1;
    srv.res.dac[0] = 0xc0;
    await views.sound.refresh(srv.api);
    assert.equal(chRows(0)[0].childNodes[1], cell, 'stejný prvek');
    assert.equal(cell.textContent, '$064 100');
    assert.equal(byClass(chips()[0], 'sd-bar')[0].childNodes[0].style.width, '33%');
    const chg = regCells(0).map((x: any, i: number) => (x.classList.contains('chg') ? i : -1)).filter((i: number) => i >= 0);
    assert.deepEqual(chg, [0, 8]);
    assert.ok(chips()[1].classList.contains('active') && !chips()[1].classList.contains('idle'));
    assert.ok(!chips()[2].classList.contains('idle'), 'TurboSound zapnutý');
    assert.equal(byClass(chips()[1], 'sd-badge')[0].textContent, t('sound.active'));
    assert.ok(byClass(root, 'sd-info')[0].textContent.includes(t('sound.activeChip', 1)));
    assert.ok(byClass(root, 'sd-info')[0].textContent.includes(t('sound.turboOn')));
    assert.equal(byClass(root, 'sd-colbar')[0].childNodes[0].style.height, '75%');
    // další obnovení bez změny: zvýraznění zmizí; DOM neroste (2× za sekundu po dlouhou dobu)
    for (let i = 0; i < 20; i++) await views.sound.refresh(srv.api);
    assert.equal(regCells(0).filter((x: any) => x.classList.contains('chg')).length, 0);
    assert.equal(find(root, () => true).length, count);
    assert.equal(srv.log.filter((c) => c === 'soundState').length, 22);
});

test('Zvuk: bez DAC, bez sezení, chyba', async () => {
    const { srv, views, root, t } = await setup('en');
    srv.res.dac = null;
    await views.sound.refresh(srv.api);
    assert.equal(byClass(root, 'sd-dac')[0].hidden, true);
    const none = find(root, (e) => e.textContent === t('sound.noDac') && e.tagName === 'DIV')[0];
    assert.equal(none.hidden, false);
    const off = Object.create(srv.api, { state: { value: { attached: false, paused: false } } });
    await views.sound.refresh(off);
    assert.equal(byClass(root, 'sd-info')[0].textContent, 'No debug session.');
    const bad = Object.create(srv.api, { request: { value: async () => { throw new Error('boom'); } } });
    await assert.rejects(views.sound.refresh(bad), /boom/);
});

test('Zvuk: jména not podle jazyka (H v češtině a němčině, Do–Si v románských)', async () => {
    const period = 221;   // 494,9 Hz → B4 / H4 / Si4
    const note = async (lang: string) => {
        const s = await setup(lang);
        s.srv.res.chips[0].regs[0] = period;
        await s.views.sound.refresh(s.srv.api);
        return s.chRows(0)[0].childNodes[3].textContent.split(' ')[0];
    };
    assert.equal(await note('en'), 'B4');
    assert.equal(await note('cs'), 'H4');
    assert.equal(await note('de'), 'H4');
    assert.equal(await note('fr'), 'Si4');
    for (const l of LANGS) assert.equal(dict('sound')[l]['sound.noteNames'].split(',').length, 12, 'noteNames ' + l);
});

for (const lang of ['en', 'cs', 'de']) {
    test('Zvuk: všechny texty přeložené (' + lang + ')', async () => {
        const { root, views, srv } = await setup(lang);
        const all: string[] = [];
        texts(root, all);
        srv.res.active = 2;
        srv.res.turbosound = true;
        srv.res.dac = null;
        await views.sound.refresh(srv.api);
        texts(root, all);
        // všechny tvary obálky
        for (let s = 0; s < 16; s++) {
            srv.res.chips[1].regs[13] = s;
            await views.sound.refresh(srv.api);
            texts(byClass(root, 'sd-chip')[1], all);
        }
        all.push(views.sound.title);
        assert.deepEqual([...new Set(all.filter((s) => /\bsound\.[a-zA-Z]/.test(s)))], [], 'klíč bez překladu');
        if (lang !== 'cs') assert.deepEqual([...new Set(all.filter((s) => /[ěščřžůňťďĚŠČŘŽŮŇŤĎ]/.test(s)))], [], 'čeština v ' + lang);
        assert.ok(all.length > 100);
    });
}

test('Zvuk: slovník – stejné klíče ve 13 jazycích, jen předpona sound., stejné parametry', () => {
    const d = dict('sound');
    assert.deepEqual(Object.keys(d).sort(), [...LANGS].sort());
    const en = Object.keys(d.en).sort();
    const params = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
    for (const l of LANGS) {
        assert.deepEqual(Object.keys(d[l]).sort(), en, 'klíče ' + l);
        for (const k of en) {
            assert.ok(k.startsWith('sound.'), k);
            assert.ok(d[l][k].trim(), 'prázdný ' + l + ' ' + k);
            assert.equal(params(d[l][k]), params(d.en[k]), 'parametry ' + l + ' ' + k);
        }
    }
    const src = fs.readFileSync(path.join(ROOT, 'media', 'views', 'sound.js'), 'utf8');
    for (const m of src.matchAll(/'(sound\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)'/g)) assert.ok(m[1] in d.en, 'chybí ' + m[1]);
    for (const k of ['decay', 'attack', 'sawDown', 'triDown', 'decayHold', 'sawUp', 'attackHold', 'triUp']) assert.ok('sound.env.' + k in d.en, k);
});
