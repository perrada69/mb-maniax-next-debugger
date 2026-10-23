// Framework panelu Next (media/next.js): registrace pohledů, výběr záložky a NextView.show.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { document, EXT, FakeElement, FakeNode } from './fakedom';

/** Načte next.js s danými pohledy ve vm kontextu jako ve webview. */
function loadPanel(views: Array<{ id: string; order: number }>) {
    const ids: Record<string, FakeElement> = {};
    for (const id of ['tabs', 'content', 'status', 'refresh']) ids[id] = new FakeElement(id === 'refresh' ? 'button' : 'div');
    ids.live = new FakeElement('input');
    const posted: any[] = [];
    const mounted: string[] = [];
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const timers: Array<() => void> = [];
    const window: any = {
        addEventListener: (t: string, f: (e: any) => void) => (listeners[t] ??= []).push(f),
        L10N: { lang: 'en', texts: {} },
    };
    const ctx = vm.createContext({
        window,
        document: { ...document, getElementById: (id: string) => ids[id] },
        Node: FakeNode,
        acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined, postMessage: (m: any) => posted.push(m) }),
        setInterval: () => 0,
        setTimeout: (f: () => void) => (timers.push(f), 0),
        console,
        atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    });
    window.window = window;
    vm.runInContext(fs.readFileSync(path.join(EXT, 'media', 'next.js'), 'utf8'), ctx);
    const NextView = window.NextView;
    for (const v of views) NextView.register({ id: v.id, title: v.id, order: v.order, mount: () => mounted.push(v.id), refresh: async () => undefined });
    // init běží odloženě (setTimeout), až se pohledy zaregistrují
    for (const f of timers.splice(0)) f();
    return { NextView, ids, mounted, posted };
}

test('NextView.show přepne na záložku podle id a neznámé id nic neudělá', () => {
    const { NextView, ids, mounted } = loadPanel([
        { id: 'memmap', order: 86 },
        { id: 'memory', order: 85 },
    ]);
    const tabs = ids.tabs.children as FakeElement[];
    assert.equal(tabs.length, 2, 'záložky postavené');
    // první podle order = memory
    assert.deepEqual(mounted, ['memory']);
    assert.equal(NextView.show('memmap'), true);
    assert.deepEqual(mounted, ['memory', 'memmap']);
    assert.ok(tabs[1].classList.contains('active'));
    assert.ok(!tabs[0].classList.contains('active'));
    assert.equal(NextView.show('neexistuje'), false);
    assert.ok(tabs[1].classList.contains('active'), 'neznámé id nezmění výběr');
});
