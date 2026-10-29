// Paprsek na obrazovce: čisté výpočty značek v media/screen.js, chování webview (zastavení →
// dotaz raster → kreslení, za běhu nic, tlačítko a setState) a hostitel v src/screen.ts.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { setLanguage } from '../../src/i18n';
import { ScreenPanel } from '../../src/screen';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'media', 'screen.js'), 'utf8');

/** Čisté funkce ze screen.js (bez webview: `module` je, acquireVsCodeApi ne; stejný realm kvůli deepEqual). */
function pure(): { rasterMarks: Function; rasterLabel: Function } {
    const module = { exports: {} as any };
    new Function('module', SRC)(module);
    return module.exports;
}

test('rasterMarks: čára přes řádek a značka na sloupci v pixelech plátna 640 × 256', () => {
    const { rasterMarks } = pure();
    const m = rasterMarks({ x: 100, y: 50 }, 640, 256);
    assert.deepEqual(m.line, { x: 0, y: 50, w: 640, h: 1 });
    assert.equal(m.mark.x, 200);
    assert.equal(m.mark.w, 2);
    assert.ok(m.mark.y <= 50 && m.mark.y + m.mark.h > 50);
    // plátno 320 × 256 a dvojnásobné 640 × 512
    assert.deepEqual(rasterMarks({ x: 10, y: 20 }, 320, 256).line, { x: 0, y: 20, w: 320, h: 1 });
    const big = rasterMarks({ x: 10, y: 20 }, 640, 512);
    assert.deepEqual(big.line, { x: 0, y: 40, w: 640, h: 2 });
    assert.equal(big.mark.x, 20);
});

test('rasterMarks: okraje, zatemnění řádku a mimo obraz', () => {
    const { rasterMarks } = pure();
    assert.equal(rasterMarks({ x: 10, y: -1 }, 640, 256), null);
    assert.equal(rasterMarks({ x: -1, y: -1 }, 640, 256), null);
    assert.equal(rasterMarks(null, 640, 256), null);
    assert.equal(rasterMarks({ x: 10, y: 256 }, 640, 256), null);
    assert.equal(rasterMarks({ x: 10, y: 10 }, 0, 0), null);
    // x mimo (zatemnění řádku): jen čára
    const hb = rasterMarks({ x: -1, y: 100 }, 640, 256);
    assert.equal(hb.mark, null);
    assert.equal(hb.line.y, 100);
    // rohy: značka nevyleze z plátna
    const last = rasterMarks({ x: 319, y: 255 }, 640, 256);
    assert.equal(last.line.y, 255);
    assert.ok(last.mark.x + last.mark.w <= 640);
    assert.ok(last.mark.y + last.mark.h <= 256);
    const first = rasterMarks({ x: 0, y: 0 }, 640, 256);
    assert.equal(first.mark.y, 0);
    assert.equal(first.mark.x, 0);
});

test('rasterLabel: řádek a sloupec, mimo obraz syrové čítače', () => {
    const { rasterLabel } = pure();
    assert.deepEqual(rasterLabel({ x: 64, y: 120, vc: 152, hc: 100 }), ['screen.beamPos', 120, 64]);
    assert.deepEqual(rasterLabel({ x: -1, y: -1, vc: 300, hc: 10 }), ['screen.beamOutside', 300, 10]);
    assert.deepEqual(rasterLabel({ x: -1, y: 5 }), ['screen.beamOutside', '?', '?']);
    assert.equal(rasterLabel(null), null);
});

// ------------------------------------------------------------------ webview nad podvrženým DOM

function fakeWebview(state: any) {
    const posted: any[] = [];
    const fills: Array<{ style: string; rect: number[] }> = [];
    let listener: (ev: any) => void = () => undefined;
    const ctx: any = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        clearRect: () => (fills.length = 0),
        fillRect: (...r: number[]) => fills.push({ style: ctx.fillStyle, rect: r }),
        strokeRect: () => undefined,
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => undefined,
    };
    const el = (id: string): any => {
        const handlers: Record<string, Function> = {};
        const classes = new Set<string>();
        return {
            id,
            width: 640,
            height: 256,
            textContent: '',
            title: '',
            disabled: false,
            attrs: {} as Record<string, string>,
            handlers,
            classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) },
            setAttribute(k: string, v: string) {
                this.attrs[k] = v;
            },
            addEventListener: (ev: string, h: Function) => (handlers[ev] = h),
            getContext: () => ctx,
            focus: () => undefined,
        };
    };
    const els: Record<string, any> = {};
    let saved = state;
    const sandbox: any = {
        document: { getElementById: (id: string) => (els[id] ??= el(id)), addEventListener: () => undefined },
        window: { L10N: { lang: 'cs', texts: { 'screen.beamPos': 'Řádek {0}, sloupec {1}', 'screen.beamOutside': 'Mimo ({0}, {1})' } }, addEventListener: (_: string, l: any) => (listener = l) },
        acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => saved, setState: (s: any) => (saved = s) }),
        AudioContext: function () {},
    };
    sandbox.window.window = sandbox.window;
    vm.runInNewContext(SRC, sandbox);
    return {
        posted,
        fills,
        els,
        state: () => saved,
        send: (data: any) => listener({ data }),
        rasterRequests: () => posted.filter((m) => m.type === 'raster'),
    };
}

const CYAN = 'rgba(0, 255, 255, 0.55)';

test('webview: po zastavení se zeptá na paprsek a nakreslí čáru a značku, za běhu je skryje', () => {
    const w = fakeWebview(undefined);
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: false });
    const req = w.rasterRequests();
    assert.equal(req.length, 1);
    w.send({ type: 'raster', seq: req[0].seq, data: { vc: 152, hc: 100, x: 64, y: 120 } });
    assert.ok(w.fills.some((f) => f.style === CYAN && f.rect[1] === 120 && f.rect[2] === 640));
    assert.ok(w.fills.some((f) => f.style === '#ff30ff' && f.rect[0] === 128));
    assert.equal(w.els.raster.textContent, 'Řádek 120, sloupec 64');
    // rozběhnutí: značky i text pryč, žádný další dotaz
    w.send({ type: 'state', running: true });
    assert.equal(w.fills.length, 0);
    assert.equal(w.els.raster.textContent, '');
    assert.equal(w.rasterRequests().length, 1);
    // pozdní odpověď na staré zastavení se zahodí
    w.send({ type: 'raster', seq: req[0].seq, data: { x: 1, y: 1 } });
    assert.equal(w.fills.length, 0);
});

test('webview: tlačítko paprsku vypíná a zapíná, volba se pamatuje přes setState', () => {
    const w = fakeWebview(undefined);
    assert.equal(w.els.beam.classList.contains('on'), true);
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: false });
    w.send({ type: 'raster', seq: w.rasterRequests()[0].seq, data: { x: 10, y: 10 } });
    assert.ok(w.fills.length > 0);
    w.els.beam.handlers.click();
    assert.equal(w.state().beam, false);
    assert.equal(w.els.beam.attrs['aria-pressed'], 'false');
    assert.equal(w.fills.length, 0);
    assert.equal(w.els.raster.textContent, '');
    // vypnuto: zastavení se na paprsek neptá
    w.send({ type: 'state', running: false });
    assert.equal(w.rasterRequests().length, 1);
    // zapnutí v pauze: hned dotaz
    w.els.beam.handlers.click();
    assert.equal(w.state().beam, true);
    assert.equal(w.rasterRequests().length, 2);

    // nový panel s uloženým stavem: vypnuto
    const w2 = fakeWebview({ beam: false });
    assert.equal(w2.els.beam.classList.contains('on'), false);
    w2.send({ type: 'attached' });
    w2.send({ type: 'state', running: false });
    assert.equal(w2.rasterRequests().length, 0);
});

test('webview: zvýraznění z panelu Next a paprsek se kreslí spolu', () => {
    const w = fakeWebview(undefined);
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: false });
    w.send({ type: 'raster', seq: w.rasterRequests()[0].seq, data: { x: 10, y: 10 } });
    w.send({ type: 'highlight', rect: { x: 0, y: 0, w: 16, h: 16 } });
    assert.ok(w.fills.some((f) => f.style === CYAN));
    assert.ok(w.fills.some((f) => f.style.startsWith('rgba(255, 255, 0')));
    w.send({ type: 'detached' });
    assert.equal(w.fills.length, 0);
});

// ------------------------------------------------------------------ hostitel (src/screen.ts)

test('ScreenPanel: dotaz raster jde na server jen v pauze, chyba serveru → null', async () => {
    setLanguage('en');
    const panel = new ScreenPanel((vscode as any).Uri.file('/ext'));
    const posted: any[] = [];
    (panel as any).panel = { webview: { postMessage: async (m: any) => void posted.push(m) } };
    let running = false;
    let fail = false;
    const asked: string[] = [];
    (panel as any).session = {
        isRunning: () => running,
        serverRequest: async (cmd: string) => {
            asked.push(cmd);
            if (fail) throw new Error('unknown command');
            return { id: 7, ok: true, vc: 152, hc: 100, x: 64, y: 120, frame: 3, cycleInFrame: 1000, linesPerFrame: 312 };
        },
    };
    const wait = () => new Promise((r) => setTimeout(r, 1));
    (panel as any).onMessage({ type: 'raster', seq: 1 });
    await wait();
    assert.deepEqual(posted.at(-1), { type: 'raster', seq: 1, data: { vc: 152, hc: 100, x: 64, y: 120, frame: 3, cycleInFrame: 1000, linesPerFrame: 312 } });
    running = true;
    (panel as any).onMessage({ type: 'raster', seq: 2 });
    await wait();
    assert.deepEqual(posted.at(-1), { type: 'raster', seq: 2, data: null });
    running = false;
    fail = true;
    (panel as any).onMessage({ type: 'raster', seq: 3 });
    await wait();
    assert.deepEqual(posted.at(-1), { type: 'raster', seq: 3, data: null });
    assert.deepEqual(asked, ['raster', 'raster']);
});

test('ScreenPanel: lišta má tlačítko paprsku a místo pro polohu', () => {
    const panel = new ScreenPanel((vscode as any).Uri.file('/ext'));
    const webview = { cspSource: 'csp', asWebviewUri: (u: any) => u.fsPath };
    const html: string = (panel as any).html(webview, (vscode as any).Uri.file('/ext/media'));
    assert.match(html, /<button id="beam"[^>]*title="Beam position/);
    assert.match(html, /<span id="raster"><\/span>/);
});
