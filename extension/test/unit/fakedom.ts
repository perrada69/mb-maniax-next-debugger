// Podvržený DOM a api panelu Next (media/next.js) pro testy pohledů media/views/*.js mimo webview.
// Pohled se načte ve vm kontextu se stejnými globály jako ve webview (document, window, NextView);
// `el`, `t`, `rgb`, `css`, `hex` jsou kopie z media/next.js (ať se testuje chování panelu).
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

export const EXT = path.join(__dirname, '..');
export const VIEWS = path.join(EXT, 'media', 'views');
const L10N = path.join(EXT, 'l10n');

export class FakeNode {
    parentNode: FakeElement | null = null;
    get textContent(): string {
        return '';
    }
}

export class FakeText extends FakeNode {
    constructor(public data: string) {
        super();
    }
    get textContent(): string {
        return this.data;
    }
}

export interface FakeImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

export class FakeElement extends FakeNode {
    readonly tagName: string;
    children: FakeNode[] = [];
    attrs: Record<string, string> = {};
    style: Record<string, any> = {};
    dataset: Record<string, string> = {};
    listeners: Record<string, Array<(ev: any) => void>> = {};
    className = '';
    title = '';
    hidden = false;
    checked = false;
    disabled = false;
    type = '';
    scrollTop = 0;
    clientHeight = 300;
    width = 300;
    height = 150;
    /** poslední obrázek z putImageData (canvas) a počet kreslení */
    image?: FakeImage;
    puts = 0;
    private _value?: string;
    private ctx?: any;
    readonly classList = {
        contains: (c: string) => this.className.split(/\s+/).includes(c),
        add: (...cs: string[]) => {
            for (const c of cs) if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim();
        },
        remove: (...cs: string[]) => {
            this.className = this.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(' ');
        },
        toggle: (c: string, on?: boolean) => {
            const want = on === undefined ? !this.classList.contains(c) : on;
            if (want) this.classList.add(c);
            else this.classList.remove(c);
            return want;
        },
    };

    constructor(tag: string) {
        super();
        this.tagName = tag.toUpperCase();
    }

    get value(): string {
        if (this._value !== undefined) return this._value;
        if (this.tagName === 'SELECT') {
            const opts = this.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === 'OPTION');
            const o = opts.find((x) => 'selected' in x.attrs) ?? opts[0];
            return o ? (o.attrs.value ?? o.textContent) : '';
        }
        return this.attrs.value ?? '';
    }
    set value(v: string) {
        this._value = String(v);
    }

    get textContent(): string {
        return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
        this.children = [];
        if (v !== '' && v !== undefined && v !== null) this.appendChild(new FakeText(String(v)));
    }

    appendChild<T extends FakeNode>(c: T): T {
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    append(...cs: Array<FakeNode | string>): void {
        for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c);
    }
    replaceChildren(...cs: Array<FakeNode | string>): void {
        this.children = [];
        this.append(...cs);
    }
    remove(): void {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
    }
    setAttribute(k: string, v: any): void {
        this.attrs[k] = String(v);
        if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
        if (k === 'type') this.type = String(v);
        if (k === 'value') this._value = undefined;
    }
    getAttribute(k: string): string | null {
        return k in this.attrs ? this.attrs[k] : null;
    }
    removeAttribute(k: string): void {
        delete this.attrs[k];
    }
    addEventListener(t: string, f: (ev: any) => void): void {
        (this.listeners[t] ??= []).push(f);
    }
    removeEventListener(t: string, f: (ev: any) => void): void {
        this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
    }
    /** Událost s `target` = tento prvek (nebo z `ev`). */
    fire(t: string, ev: Record<string, any> = {}): void {
        for (const f of this.listeners[t] ?? []) f({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev });
    }
    closest(sel: string): FakeElement | null {
        let e: FakeElement | null = this;
        while (e) {
            if (e.tagName === sel.toUpperCase()) return e;
            e = e.parentNode;
        }
        return null;
    }
    getBoundingClientRect() {
        const w = parseFloat(this.style.width) || this.width;
        const h = parseFloat(this.style.height) || this.height;
        return { left: 0, top: 0, x: 0, y: 0, width: w, height: h, right: w, bottom: h };
    }
    scrollIntoView(): void {}
    focus(): void {}
    getContext(): any {
        if (!this.ctx) {
            const self = this;
            this.ctx = {
                imageSmoothingEnabled: true,
                createImageData: (w: number, h: number): FakeImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData(img: FakeImage) {
                    self.image = img;
                    self.puts++;
                },
                drawImage() {},
                fillRect() {},
                strokeRect() {},
                clearRect() {},
                setLineDash() {},
                beginPath() {},
                moveTo() {},
                lineTo() {},
                stroke() {},
            };
        }
        return this.ctx;
    }
}

export const document = {
    createElement: (t: string) => new FakeElement(t),
    createTextNode: (t: string) => new FakeText(String(t)),
    hidden: false,
};

/** Všechny prvky stromu, které splní podmínku (včetně kořene). */
export function findAll(root: FakeNode, pred: (e: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
    if (root instanceof FakeElement) {
        if (pred(root)) out.push(root);
        for (const c of root.children) findAll(c, pred, out);
    }
    return out;
}

export const byClass = (c: string) => (e: FakeElement) => e.classList.contains(c);
export const byTag = (t: string) => (e: FakeElement) => e.tagName === t.toUpperCase();

/** Texty stromu pro kontrolu překladů: textové uzly, title, placeholder, aria-label. */
export function domStrings(root: FakeNode, out: string[] = []): string[] {
    if (root instanceof FakeText) out.push(root.data);
    else if (root instanceof FakeElement) {
        if (root.title) out.push(root.title);
        for (const a of ['placeholder', 'aria-label', 'title']) if (root.attrs[a]) out.push(root.attrs[a]);
        for (const c of root.children) domStrings(c, out);
    }
    return out.filter((s) => s !== '');
}

/** Pixel obrázku (RGBA). */
export function px(img: FakeImage | undefined, x: number, y: number): number[] {
    if (!img) throw new Error('canvas bez obrázku');
    const o = (y * img.width + x) * 4;
    return Array.from(img.data.slice(o, o + 4));
}

/** RGB333 → [r, g, b] jako api.rgb. */
export function rgb333(c: number): number[] {
    const c8 = (v: number) => ((v << 5) | (v << 2) | (v >> 1)) & 0xff;
    return [c8((c >> 6) & 7), c8((c >> 3) & 7), c8(c & 7)];
}

export const b64 = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
export const tick = () => new Promise((r) => setTimeout(r, 0));

/** Slovník jako window.L10N z rozšíření: angličtina + vybraný jazyk pro dané oblasti. */
export function dictionary(lang: string, areas: string[]): Record<string, string> {
    const texts: Record<string, string> = {};
    for (const a of areas) {
        const d = JSON.parse(fs.readFileSync(path.join(L10N, a + '.json'), 'utf8'));
        Object.assign(texts, d.en, d[lang] ?? {});
    }
    return texts;
}

/** t() z media/next.js nad slovníkem. */
export function translator(texts: Record<string, string>) {
    return (key: string, ...args: unknown[]): string => {
        const s = texts[key] ?? key;
        return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
    };
}

export interface FakeApi {
    request(cmd: string, args?: any): Promise<any>;
    bytes(b: string): Uint8Array;
    rgb(c: number): number[];
    css(c: number): string;
    hex(v: number, d?: number): string;
    canvas(w: number, h: number, s?: number): FakeElement;
    el(tag: string, attrs?: any, ...children: any[]): FakeElement;
    t(key: string, ...args: unknown[]): string;
    lang: string;
    state: { attached: boolean; paused: boolean };
    highlight(r: any): void;
    /** záznam dotazů [cmd, args] a zvýraznění (jen v testu) */
    log: Array<[string, any]>;
    highlights: any[];
}

/** api pohledů jako v media/next.js; `server(cmd, args)` vrací odpověď nebo hází chybu. */
export function makeApi(lang: string, texts: Record<string, string>, server: (cmd: string, args: any) => any): FakeApi {
    const t = translator(texts);
    function append(parent: FakeElement, child: any): void {
        if (child === null || child === undefined || child === false) return;
        if (Array.isArray(child)) child.forEach((c) => append(parent, c));
        else parent.appendChild(child instanceof FakeNode ? child : document.createTextNode(String(child)));
    }
    function el(tag: string, attrs?: any, ...children: any[]): FakeElement {
        const e = document.createElement(tag);
        if (attrs && (typeof attrs !== 'object' || attrs instanceof FakeNode || Array.isArray(attrs))) {
            children.unshift(attrs);
            attrs = null;
        }
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') e.className = v as string;
            else if (k === 'title') e.title = v as string;
            else if (k === 'style') {
                if (typeof v === 'string') e.style.cssText = v;
                else Object.assign(e.style, v);
            } else if (/^on[A-Z]/.test(k) && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as any);
            else e.setAttribute(k, v === true ? '' : v);
        }
        append(e, children);
        return e;
    }
    const api: FakeApi = {
        log: [],
        highlights: [],
        request(cmd, args) {
            api.log.push([cmd, args]);
            return Promise.resolve().then(() => server(cmd, args || {}));
        },
        bytes: (b) => new Uint8Array(Buffer.from(b || '', 'base64')),
        rgb: rgb333,
        css: (c) => '#' + rgb333(c).map((v) => v.toString(16).padStart(2, '0')).join(''),
        hex: (v, d) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d || 2, '0'),
        canvas(w, h, s) {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            c.style.width = w * (s || 1) + 'px';
            c.style.height = h * (s || 1) + 'px';
            return c;
        },
        el,
        t,
        lang,
        state: { attached: true, paused: true },
        highlight(r) {
            api.highlights.push(r ? JSON.parse(JSON.stringify(r)) : r);
        },
    };
    return api;
}

export interface LoadedViews {
    /** zaregistrované pohledy podle id */
    defs: Record<string, any>;
    /** globály kontextu (window.NextRegNames …) */
    window: any;
    /** vnitřní funkce pohledu vystavené přes `expose` */
    x: Record<string, any>;
}

/**
 * Načte soubory pohledů do jednoho kontextu (jako skripty ve webview). `expose` = jména vnitřních
 * funkcí posledního souboru, které se před NextView.register uloží do `x` (testy dekódování).
 */
export function loadViews(files: string[], lang: string, texts: Record<string, string>, expose: string[] = []): LoadedViews {
    const defs: Record<string, any> = {};
    const t = translator(texts);
    const ctx: any = {
        document,
        console,
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => undefined,
        requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        Node: FakeNode,
        L10N: { lang, texts },
        NextView: Object.freeze({
            t,
            lang,
            register(d: any) {
                if (defs[d.id]) throw new Error('duplicitní pohled ' + d.id);
                defs[d.id] = d;
            },
        }),
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    files.forEach((f, i) => {
        let src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
        if (i === files.length - 1 && expose.length) {
            if (!src.includes('NextView.register(')) throw new Error(f + ': chybí NextView.register');
            src = src.replace('NextView.register(', `globalThis.__x = { ${expose.join(', ')} }; NextView.register(`);
        }
        vm.runInContext(src, ctx, { filename: f });
    });
    return { defs, window: ctx, x: ctx.__x ?? {} };
}

/** Jazyky, ve kterých se pohledy zkouší (jazyk s diakritikou, bez ní a výchozí). */
export const TEST_LANGS = ['en', 'cs', 'de'];

/** Kontrola textů v DOM: žádný klíč slovníku, žádný nenahrazený parametr {n}, žádná čeština mimo cs/sk. */
export function checkTexts(strings: string[], lang: string, areas: string[], where: string): void {
    const keyRe = new RegExp(`\\b(?:${areas.join('|')})\\.[a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*\\b`);
    for (const s of strings) {
        const m = keyRe.exec(s);
        if (m && !/\.(js|css|json)\b/.test(m[0])) throw new Error(`${where} [${lang}]: nepřeložený klíč ${m[0]} v „${s}“`);
        if (/\{\d+\}/.test(s)) throw new Error(`${where} [${lang}]: nenahrazený parametr v „${s}“`);
        if (lang !== 'cs' && lang !== 'sk' && /[ěščřžůťďňĚŠČŘŽŮŤĎŇ]/.test(s)) throw new Error(`${where} [${lang}]: český text „${s}“`);
    }
}
