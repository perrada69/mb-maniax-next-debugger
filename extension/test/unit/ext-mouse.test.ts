// Kempstonova myš v panelu obrazovky: čisté výpočty v media/screen.js (posun, kolečko, Ctrl+Alt),
// webview nad podvrženým DOM s pointer lockem a hostitel src/screen.ts (pozná, že program čte myš).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { setLanguage } from '../../src/i18n';
import { ScreenPanel } from '../../src/screen';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'media', 'screen.js'), 'utf8');

function pure(): { takeMotion: Function; wheelSteps: Function; isReleaseChord: Function } {
    const module = { exports: {} as any };
    new Function('module', SRC)(module);
    return module.exports;
}

test('takeMotion: měřítko panelu, celé body ven, zlomky zůstanou na příště', () => {
    const { takeMotion } = pure();
    const acc = { x: 0, y: 0 };
    assert.deepEqual(takeMotion(acc, 10, -4, 0.5), { dx: 5, dy: -2 });
    // pomalý pohyb: 0,4 + 0,4 + 0,4 → první celý bod až potřetí
    assert.deepEqual(takeMotion(acc, 1, 1, 0.4), { dx: 0, dy: 0 });
    assert.deepEqual(takeMotion(acc, 1, 1, 0.4), { dx: 0, dy: 0 });
    assert.deepEqual(takeMotion(acc, 1, 1, 0.4), { dx: 1, dy: 1 });
    // záporný směr se ořízne k nule, zbytek se nezaokrouhlí na opačnou stranu
    const neg = { x: 0, y: 0 };
    assert.deepEqual(takeMotion(neg, -3, 0, 0.5), { dx: -1, dy: 0 });
    assert.ok(Math.abs(neg.x + 0.5) < 1e-9);
    assert.deepEqual(takeMotion(neg, -1, 0, 0.5), { dx: -1, dy: 0 });
});

test('wheelSteps: krok kolečka podle deltaMode, od sebe kladně, jemné kolečko se střádá', () => {
    const { wheelSteps } = pure();
    const acc = { v: 0 };
    assert.equal(wheelSteps(acc, -100, 0), 1);    // od sebe (px)
    assert.equal(wheelSteps(acc, 100, 0), -1);    // k sobě
    assert.equal(wheelSteps(acc, 3, 1), -1);      // řádky
    assert.equal(wheelSteps(acc, -1, 2), 1);      // stránka
    assert.equal(wheelSteps(acc, -40, 0), 0);     // touchpad: 40 + 40 + 40 px = 1 krok
    assert.equal(wheelSteps(acc, -40, 0), 0);
    assert.equal(wheelSteps(acc, -40, 0), 1);
    assert.equal(wheelSteps({ v: 0 }, -300, 0), 3);
});

test('isReleaseChord: jen levý Ctrl + levý Alt (AltGr = Ctrl + pravý Alt nepustí)', () => {
    const { isReleaseChord } = pure();
    assert.equal(isReleaseChord(new Set(['ControlLeft', 'AltLeft'])), true);
    assert.equal(isReleaseChord(new Set(['ControlLeft', 'AltLeft', 'KeyA'])), true);
    assert.equal(isReleaseChord(new Set(['ControlLeft', 'AltRight'])), false);
    assert.equal(isReleaseChord(new Set(['ControlRight', 'AltLeft'])), false);
    assert.equal(isReleaseChord(new Set(['ControlLeft'])), false);
});

// ------------------------------------------------------------------ webview nad podvrženým DOM

function fakeWebview() {
    const posted: any[] = [];
    const frames: Function[] = [];
    let listener: (ev: any) => void = () => undefined;
    const docHandlers: Record<string, Function[]> = {};
    const doc: any = {
        pointerLockElement: null,
        lockRequests: 0,
        lockFails: false,
        getElementById: (id: string) => (els[id] ??= el(id)),
        addEventListener: (ev: string, h: Function) => (docHandlers[ev] ??= []).push(h),
        exitPointerLock() {
            doc.pointerLockElement = null;
            for (const h of docHandlers.pointerlockchange ?? []) h({});
        },
    };
    const ctx: any = {
        clearRect: () => undefined,
        fillRect: () => undefined,
        strokeRect: () => undefined,
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => undefined,
    };
    const el = (id: string): any => {
        const handlers: Record<string, Function[]> = {};
        const classes = new Set<string>();
        const e: any = {
            id,
            width: 640,
            height: 256,
            clientWidth: 640,
            textContent: '',
            title: '',
            disabled: false,
            handlers,
            classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) },
            setAttribute: () => undefined,
            addEventListener: (ev: string, h: Function) => (handlers[ev] ??= []).push(h),
            getContext: () => ctx,
            focus: () => undefined,
            fire(ev: string, data: any = {}) {
                const evt = { preventDefault: () => (evt.prevented = true), stopPropagation: () => undefined, prevented: false, ...data };
                for (const h of handlers[ev] ?? []) h(evt);
                return evt;
            },
        };
        if (id === 'screen')
            e.requestPointerLock = () => {
                doc.lockRequests++;
                if (doc.lockFails) return Promise.reject(new Error('cooldown'));
                doc.pointerLockElement = e;
                for (const h of docHandlers.pointerlockchange ?? []) h({});
                return Promise.resolve();
            };
        return e;
    };
    const els: Record<string, any> = {};
    const sandbox: any = {
        document: doc,
        window: {
            L10N: { lang: 'cs', texts: { 'screen.hint': 'H', 'screen.hintMouse': 'HM', 'screen.hintMouseCaptured': 'HC' } },
            addEventListener: (_: string, l: any) => (listener = l),
            requestAnimationFrame: (f: Function) => frames.push(f),
        },
        acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => undefined, setState: () => undefined }),
        AudioContext: function () {},
    };
    sandbox.window.window = sandbox.window;
    vm.runInNewContext(SRC, sandbox);
    return {
        posted,
        doc,
        canvas: els.screen,
        hint: els.hint,
        send: (data: any) => listener({ data }),
        // jiný realm (vm) → přes JSON, ať deepEqual porovná jen obsah
        mouse: () => posted.filter((m) => m.type === 'mouse').map((m) => JSON.parse(JSON.stringify(m.args))),
        flush: () => frames.splice(0).forEach((f) => f()),
    };
}

/** Běžící stroj, program čte myš. */
function running() {
    const w = fakeWebview();
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: true });
    w.send({ type: 'mouse', used: true });
    return w;
}

test('webview: kliknutí zachytí myš jen za běhu a když program myš čte', () => {
    const w = fakeWebview();
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: true });
    assert.equal(w.hint.textContent, 'H');
    w.canvas.fire('mousedown', { buttons: 1 });
    assert.equal(w.doc.lockRequests, 0, 'program myš nečte');

    w.send({ type: 'mouse', used: true });
    assert.equal(w.hint.textContent, 'HM');
    assert.equal(w.canvas.classList.contains('mouse'), true);
    w.send({ type: 'state', running: false });
    w.canvas.fire('mousedown', { buttons: 1 });
    assert.equal(w.doc.lockRequests, 0, 'stroj stojí');

    w.send({ type: 'state', running: true });
    w.canvas.fire('mousedown', { buttons: 1 });
    assert.equal(w.doc.lockRequests, 1);
    assert.equal(w.doc.pointerLockElement, w.canvas);
    assert.equal(w.hint.textContent, 'HC');
    assert.equal(w.canvas.classList.contains('mouse'), false);
    assert.deepEqual(w.mouse(), [], 'kliknutí, které myš zachytí, program nedostane');
});

test('webview: posun za snímek v bodech obrazu, tlačítka, kolečko a kontextová nabídka', () => {
    const w = running();
    w.canvas.clientWidth = 1280;   // 320 bodů na 1280 px → 1/4
    w.canvas.fire('mousedown', { buttons: 1 });
    w.canvas.fire('mouseup', { buttons: 0 });
    w.canvas.fire('mousemove', { movementX: 6, movementY: -2 });
    w.canvas.fire('mousemove', { movementX: 6, movementY: -6 });
    assert.deepEqual(w.mouse(), [], 'posun čeká na snímek');
    w.flush();
    assert.deepEqual(w.mouse(), [{ dx: 3, dy: -2 }]);
    w.canvas.fire('mousemove', { movementX: 1, movementY: 0 });
    w.flush();
    assert.deepEqual(w.mouse().length, 1, 'čtvrt bodu se ještě neposílá');

    w.canvas.fire('mousedown', { buttons: 1 });
    w.canvas.fire('mousedown', { buttons: 3 });
    w.canvas.fire('mouseup', { buttons: 2 });
    w.canvas.fire('mouseup', { buttons: 2 });   // beze změny nic
    assert.deepEqual(w.mouse().slice(1), [{ buttons: 1 }, { buttons: 3 }, { buttons: 2 }]);

    const wheel = w.canvas.fire('wheel', { deltaY: -100, deltaMode: 0 });
    assert.equal(wheel.prevented, true);
    assert.deepEqual(w.mouse().at(-1), { wheel: 1 });
    assert.equal(w.canvas.fire('contextmenu').prevented, true);
});

test('webview: levý Ctrl + levý Alt myš uvolní, Alt do emulátoru nepošle a pustí klávesy', () => {
    const w = running();
    w.canvas.fire('mousedown', { buttons: 1 });
    w.canvas.fire('mousedown', { buttons: 2 });   // pravé drží
    w.canvas.fire('keydown', { code: 'ControlLeft' });
    // AltGr = Ctrl + pravý Alt: myš zůstane
    w.canvas.fire('keydown', { code: 'AltRight' });
    assert.equal(w.doc.pointerLockElement, w.canvas);
    w.canvas.fire('keyup', { code: 'AltRight' });
    const n = w.posted.length;
    w.canvas.fire('keydown', { code: 'AltLeft' });
    assert.equal(w.doc.pointerLockElement, null);
    const after = w.posted.slice(n);
    assert.ok(!after.some((m) => m.type === 'key' && m.scancode === 226), 'Alt nejde do emulátoru');
    assert.ok(after.some((m) => m.type === 'releaseKeys'));
    assert.deepEqual(w.mouse().at(-1), { buttons: 0 }, 'držené tlačítko se pustí');
    assert.equal(w.hint.textContent, 'HM');
    // uvolněná myš: pohyb a kolečko nic neposílají
    const m = w.mouse().length;
    w.canvas.fire('mousemove', { movementX: 50, movementY: 50 });
    w.flush();
    assert.equal(w.canvas.fire('wheel', { deltaY: 100, deltaMode: 0 }).prevented, false);
    assert.equal(w.mouse().length, m);
    // bez zachycení je Ctrl+Alt obyčejné klávesy
    w.canvas.fire('keyup', { code: 'AltLeft' });
    w.canvas.fire('keydown', { code: 'AltLeft' });
    assert.equal(w.posted.at(-1).type, 'key');
});

test('webview: zastavení stroje a konec ladění myš uvolní, odmítnutý pointer lock nic nerozbije', async () => {
    const w = running();
    w.canvas.fire('mousedown', { buttons: 1 });
    w.send({ type: 'state', running: false });
    assert.equal(w.doc.pointerLockElement, null);
    w.send({ type: 'state', running: true });
    w.canvas.fire('mousedown', { buttons: 1 });
    w.send({ type: 'detached' });
    assert.equal(w.doc.pointerLockElement, null);
    assert.equal(w.hint.textContent, 'H');
    // po novém připojení se čeká na hlášení, že program myš čte
    w.send({ type: 'attached' });
    w.send({ type: 'state', running: true });
    w.canvas.fire('mousedown', { buttons: 1 });
    assert.equal(w.doc.lockRequests, 2);

    w.send({ type: 'mouse', used: true });
    w.doc.lockFails = true;
    w.canvas.fire('mousedown', { buttons: 1 });
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(w.doc.lockRequests, 3);
    assert.equal(w.doc.pointerLockElement, null);
    assert.equal(w.hint.textContent, 'HM');
});

// ------------------------------------------------------------------ hostitel (src/screen.ts)

test('ScreenPanel: podle state.mouse.reads hlásí webview, že program čte myš', async () => {
    setLanguage('en');
    const panel = new ScreenPanel((vscode as any).Uri.file('/ext'));
    const posted: any[] = [];
    (panel as any).panel = { webview: { postMessage: async (m: any) => void posted.push(m) } };
    let reads = 0;
    let frame = 0;
    (panel as any).session = { isRunning: () => true, input: () => undefined, machineState: async () => ({ frame: frame++, mouse: { reads } }) };
    const mouse = () => posted.filter((m) => m.type === 'mouse');
    const tick = () => (panel as any).measureSpeed();
    try {
        panel.state(true);   // první vzorek hned, jen výchozí stav
        await new Promise((r) => setTimeout(r, 1));
        assert.deepEqual(mouse(), []);
        reads = 10;
        await tick();
        assert.deepEqual(mouse(), [{ type: 'mouse', used: true }]);
        reads = 20;
        await tick();
        assert.equal(mouse().length, 1, 'beze změny se nic neposílá');
        await tick();   // za sekundu žádné čtení
        assert.deepEqual(mouse().at(-1), { type: 'mouse', used: false });

        // nové webview (změna jazyka) dostane stav znovu
        reads = 30;
        await tick();
        posted.length = 0;
        (panel as any).onMessage({ type: 'ready' });
        assert.deepEqual(mouse(), [{ type: 'mouse', used: true }]);
        // starý server bez mouse: nic
        (panel as any).session.machineState = async () => ({ frame: frame++ });
        posted.length = 0;
        await tick();
        assert.deepEqual(mouse(), []);
    } finally {
        panel.state(false);
    }
});
