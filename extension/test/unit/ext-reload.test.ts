// Přeložit a nahrát znovu: přepočet breakpointů podle nového SLD (session.ts), požadavek DAP
// `reload` nad podvrženým serverem, výběr úlohy a souběh v ReloadController (reload.ts),
// překlad hlášek serveru podle `key`.
import { endTask, endTaskProcess, saveDocument, startSession, vs } from './ext-vscode-setup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLanguage } from '../../src/i18n';
import { findTask, ReloadController, runTask } from '../../src/reload';
import { NextDebugSession, relocateBreakpoints, serverText, serverTextKey, SourceBp } from '../../src/session';
import { SldInfo } from '../../src/sld';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-reload-'));
const asm = path.join(dir, 'prog.asm');
const sldPath = path.join(dir, 'prog.sld');
const program = path.join(dir, 'prog.nex');
fs.writeFileSync(asm, '');
fs.writeFileSync(program, '');

/** SLD z řádků „řádek adresa“ (stránka 4 jako u ORG $8000 s DEVICE ZXSPECTRUMNEXT). */
function sld(lines: Array<[number, number]>, labels: Array<[string, number]> = []): string {
    const out = ['|SLD.data.version|1'];
    for (const [name, addr] of labels) out.push(`prog.asm|1||0|4|${addr}|F|${name}`);
    for (const [line, addr] of lines) out.push(`prog.asm|${line}||0|4|${addr}|T|`);
    return out.join('\n') + '\n';
}

// Před změnou: kód na řádcích 2, 3, 5 (řádek 4 je komentář). Po vložení `nop` na řádek 2 se vše
// posune o řádek a o bajt.
const BEFORE = sld([[2, 0x8000], [3, 0x8001], [5, 0x8004]], [['start', 0x8000]]);
const AFTER = sld([[2, 0x8000], [3, 0x8001], [4, 0x8002], [6, 0x8005]], [['start', 0x8000], ['extra', 0x8001]]);

function load(text: string): SldInfo {
    fs.writeFileSync(sldPath, text);
    return SldInfo.load(sldPath);
}

const key = path.normalize(asm).toLowerCase();

function bp(id: number, requested: number, s: SldInfo | undefined): SourceBp {
    const f = s?.addressesFor(asm, requested);
    return { id, requested, line: f?.line ?? requested, addrs: f ? [...f.addrs] : [] };
}

test('relocateBreakpoints: po novém překladu adresy podle nového SLD z řádku od uživatele', () => {
    const before = load(BEFORE);
    // 1: byl na řádku 3, VS Code ho po uložení posunul na 4 (poslal nový řádek ještě se starým SLD:
    //    komentář na 4 → padl na 5, $8004); 2: na řádku 2 před vloženým řádkem (beze změny);
    // 3: na řádku bez kódu ani pod ním
    const bps = new Map([[key, [bp(1, 4, before), bp(2, 2, before), bp(3, 40, before)]]]);
    assert.equal(bps.get(key)![0].addrs[0].addr, 0x8004);
    assert.equal(bps.get(key)![0].line, 5);
    const after = load(AFTER);
    const changed = relocateBreakpoints(bps, after);
    const [a, b, c] = bps.get(key)!;
    assert.equal(a.line, 4);
    assert.deepEqual(a.addrs, [{ addr: 0x8002, page: 4 }]);
    assert.equal(b.line, 2);
    assert.deepEqual(b.addrs, [{ addr: 0x8000, page: 4 }]);
    assert.equal(c.addrs.length, 0);
    assert.equal(c.line, 40);
    assert.deepEqual(changed.map((x) => x.id), [1]);
    // znovu se stejným SLD: nic se nemění
    assert.equal(relocateBreakpoints(bps, after).length, 0);
    // bez SLD: všechny neověřené
    relocateBreakpoints(bps, undefined);
    assert.ok(bps.get(key)!.every((x) => x.addrs.length === 0));
});

test('relocateBreakpoints: breakpoint dříve bez kódu se po překladu ověří', () => {
    const before = load(BEFORE);
    const bps = new Map([[key, [bp(7, 6, before)]]]);
    assert.equal(bps.get(key)![0].addrs.length, 0);
    relocateBreakpoints(bps, load(AFTER));
    assert.deepEqual(bps.get(key)![0].addrs, [{ addr: 0x8005, page: 4 }]);
});

test('serverText: klíč serveru přeloží, neznámý klíč nechá anglicky', () => {
    setLanguage('cs');
    assert.equal(serverTextKey('loadFailed'), 'session.serverLoadFailed');
    assert.equal(serverTextKey('esxdosWritable'), 'session.serverEsxdosWritable');
    assert.equal(serverTextKey('fooBar'), 'session.serverFooBar');
    assert.equal(serverText({ text: 'Failed to load the program: x\n', key: 'loadFailed', args: ['x'] }), 'Program se nepodařilo nahrát: x\n');
    assert.match(serverText({ text: 'esx\n', key: 'esxdosWritable', args: ['C:\\hry'] }), /C:\\hry.*\n$/);
    assert.equal(serverText({ text: 'Brand new message\n', key: 'brandNewMessage', args: [] }), 'Brand new message\n');
    assert.equal(serverText({ text: 'odd\n', key: '../x' }), 'odd\n');
    assert.equal(serverText({ text: 'plain' }), 'plain');
    setLanguage('en');
});

// ------------------------------------------------------------------ DAP reload nad podvrženým serverem

/** Podvržený server: odpovídá na příkazy a po launch / pause / continue pošle události. */
function fakeServer(session: NextDebugSession, log: string[]) {
    const ev = (e: any) => setTimeout(() => (session as any).onServerEvent(e), 5);
    return {
        send: () => undefined,
        close: () => undefined,
        async request(cmd: string, args: any = {}) {
            log.push(cmd);
            switch (cmd) {
                case 'launch':
                    ev({ event: 'stopped', reason: 'entry' });
                    return { ok: true };
                case 'pause':
                    ev({ event: 'stopped', reason: 'pause' });
                    return { ok: true };
                case 'continue':
                    ev({ event: 'continued' });
                    return { ok: true };
                case 'stepOver':
                    await new Promise((r) => setTimeout(r, 30));
                    return { ok: true };
                case 'readMemory':
                    return { ok: true, data: Buffer.alloc(args.length ?? 1).toString('base64') };
                case 'setBreakpoints':
                    (this as any).lastBps = args.breakpoints;
                    return { ok: true, breakpoints: args.breakpoints.map((b: any) => ({ id: b.id, verified: true })) };
                case 'setWatchpoints':
                    return { ok: true, watchpoints: [] };
                case 'evaluate':
                    return { ok: true, value: 0 };
                default:
                    return { ok: true };
            }
        },
    } as any;
}

function dap(session: NextDebugSession) {
    let seq = 1;
    const pending = new Map<number, (r: any) => void>();
    const events: any[] = [];
    session.onDidSendMessage((m: any) => {
        if (m.type === 'response') pending.get(m.request_seq)?.(m);
        else if (m.type === 'event') events.push(m);
    });
    return {
        events,
        request(command: string, args: any = {}): Promise<any> {
            const s = seq++;
            const p = new Promise<any>((r) => pending.set(s, r));
            session.handleMessage({ seq: s, type: 'request', command, arguments: args } as any);
            return p;
        },
    };
}

test('reload: nové SLD, breakpointy na nových adresách, souběžný reload i krok odmítnuty', async () => {
    const session = new NextDebugSession('');
    const log: string[] = [];
    const server = fakeServer(session, log);
    (session as any).server = server;
    (session as any).args = { program, sld: sldPath, stopOnEntry: true };
    (session as any).sld = load(BEFORE);
    const c = dap(session);

    const set = await c.request('setBreakpoints', { source: { path: asm }, breakpoints: [{ line: 3 }, { line: 6 }] });
    assert.equal(set.success, true);
    const [b1, b2] = set.body.breakpoints;
    assert.equal(b1.verified, true);
    assert.equal(b1.instructionReference, '0x8001');
    assert.equal(b2.verified, false);

    // nový překlad: řádek 3 má teď $8001 dál, řádek 6 nově kód $8005
    fs.writeFileSync(sldPath, AFTER);
    // VS Code po uložení posune breakpoint na řádek 4 (nový řádek, ještě staré SLD → $8004)
    const moved = await c.request('setBreakpoints', { source: { path: asm }, breakpoints: [{ line: 4 }, { line: 6 }] });
    assert.equal(moved.body.breakpoints[0].instructionReference, '0x8004');
    const ids = moved.body.breakpoints.map((b: any) => b.id);

    (session as any).running = true;   // stroj běží: reload ho nejdřív zastaví
    c.events.length = 0;
    const first = c.request('reload');
    const second = c.request('reload');
    const step = c.request('next', { threadId: 1 });
    const [r1, r2, r3] = await Promise.all([first, second, step]);
    assert.equal(r1.success, true, r1.message);
    assert.equal(r2.success, false);
    assert.equal(r3.success, false);
    assert.ok(log.indexOf('pause') >= 0 && log.indexOf('pause') < log.lastIndexOf('launch'), log.join(','));

    const changed = c.events.filter((e) => e.event === 'breakpoint').map((e) => e.body.breakpoint);
    const byId = new Map(changed.map((b: any) => [b.id, b]));
    assert.equal(byId.get(ids[0]).instructionReference, '0x8002');
    assert.equal(byId.get(ids[0]).verified, true);
    assert.equal(byId.get(ids[0]).line, 4);
    assert.equal(byId.get(ids[1]).instructionReference, '0x8005');
    assert.equal(byId.get(ids[1]).verified, true);
    // serveru šly nové adresy
    const addrs = server.lastBps.map((b: any) => b.addr).sort();
    assert.deepEqual(addrs, [0x8002, 0x8005]);
    // obnova paměti a zastavení na vstupu (stopOnEntry)
    assert.ok(c.events.some((e) => e.event === 'memory'));
    assert.ok(c.events.some((e) => e.event === 'stopped' && e.body.reason === 'entry'));
    assert.ok(!c.events.some((e) => e.event === 'stopped' && e.body.reason === 'pause'), 'zastavení kvůli reloadu se VS Code nehlásí');
    assert.equal(session.getSld()?.label('extra')?.addr, 0x8001);
    assert.equal(session.isReloading(), false);

    // po reloadu se krokovat zase dá
    const again = await c.request('next', { threadId: 1 });
    assert.equal(again.success, true);
});

test('reload: chybějící SLD → chyba, starý stav zůstane', async () => {
    const session = new NextDebugSession('');
    const log: string[] = [];
    (session as any).server = fakeServer(session, log);
    (session as any).args = { program, sld: path.join(dir, 'chybi.sld') };
    (session as any).sld = load(BEFORE);
    const c = dap(session);
    const r = await c.request('reload');
    assert.equal(r.success, false);
    assert.ok(!log.includes('launch'));
    assert.equal(session.getSld()?.label('start')?.addr, 0x8000);
});

// ------------------------------------------------------------------ rozšíření: úloha a souběh

function task(name: string, extra: any = {}): any {
    return { name, source: 'Workspace', definition: { type: 'shell', label: name }, scope: undefined, ...extra };
}

test('findTask: jméno, zdroj: jméno, ${defaultBuildTask}, identifikátor, přednost složky sezení', () => {
    const folder: any = { uri: { toString: () => 'file:///b' } };
    const a = task('sjasmplus', { scope: { uri: { toString: () => 'file:///a' } } });
    const b = task('sjasmplus', { scope: { uri: { toString: () => 'file:///b' } } });
    const def = task('build', { group: { id: 'build', isDefault: true } });
    const npm = task('watch', { source: 'npm', definition: { type: 'npm', script: 'watch' } });
    const all = [a, b, def, npm];
    assert.equal(findTask(all, 'sjasmplus', folder), b);
    assert.equal(findTask(all, 'sjasmplus'), a);
    assert.equal(findTask(all, 'npm: watch'), npm);
    assert.equal(findTask(all, '${defaultBuildTask}'), def);
    assert.equal(findTask(all, { type: 'npm', script: 'watch' }), npm);
    assert.equal(findTask(all, 'neni'), undefined);
});

test('runTask: návratový kód procesu, i když úloha skončí dřív, než executeTask vrátí', async () => {
    const exec = { id: 1 };
    vs.tasks.executeTask = async () => {
        endTaskProcess.fire({ execution: exec, exitCode: 3 });
        endTask.fire({ execution: exec });
        return exec;
    };
    assert.equal(await runTask(task('x')), 3);
    const exec2 = { id: 2 };
    vs.tasks.executeTask = async () => {
        setTimeout(() => {
            endTaskProcess.fire({ execution: { id: 'cizí' }, exitCode: 9 });
            endTaskProcess.fire({ execution: exec2, exitCode: 0 });
            endTask.fire({ execution: exec2 });
        }, 5);
        return exec2;
    };
    assert.equal(await runTask(task('x')), 0);
    assert.equal(endTask.count(), 0, 'posluchači se uvolní');
});

/** Ladicí sezení VS Code (jen co potřebuje ReloadController). */
function vsSession(preLaunchTask?: string) {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    return {
        calls,
        finish: () => release(),
        session: {
            type: 'mbx-next',
            configuration: { preLaunchTask },
            workspaceFolder: undefined,
            customRequest: (cmd: string) => {
                calls.push(cmd);
                return new Promise<void>((r) => (release = r));
            },
        } as any,
    };
}

function captureMessages() {
    const msgs: string[] = [];
    vs.window.showErrorMessage = async (m: string) => void msgs.push('error:' + m);
    vs.window.showInformationMessage = async (m: string) => void msgs.push('info:' + m);
    vs.window.showWarningMessage = async (m: string) => void msgs.push('warn:' + m);
    return msgs;
}

test('ReloadController: chyba překladu → hláška a nic se nenahraje', async () => {
    const msgs = captureMessages();
    const s = vsSession('sjasmplus');
    vs.tasks.fetchTasks = async () => [task('sjasmplus')];
    const exec = {};
    vs.tasks.executeTask = async () => {
        setTimeout(() => {
            endTaskProcess.fire({ execution: exec, exitCode: 1 });
            endTask.fire({ execution: exec });
        }, 1);
        return exec;
    };
    const rc = new ReloadController();
    assert.equal(await rc.reload(s.session), false);
    assert.deepEqual(s.calls, []);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /^error:.*sjasmplus.*1/);
});

test('ReloadController: neznámá úloha → hláška; bez sezení → varování', async () => {
    const msgs = captureMessages();
    vs.tasks.fetchTasks = async () => [task('jina')];
    const s = vsSession('sjasmplus');
    assert.equal(await new ReloadController().reload(s.session), false);
    assert.deepEqual(s.calls, []);
    assert.match(msgs[0], /^error:.*sjasmplus/);
    vs.debug.activeDebugSession = undefined;
    assert.equal(await new ReloadController().reload(), false);
    assert.match(msgs[1], /^warn:/);
});

test('ReloadController: dvojí příkaz → druhý jen hláška; uložení během reloadu → ještě jeden', async () => {
    const msgs = captureMessages();
    vs.tasks.fetchTasks = async () => [];
    const s = vsSession(undefined);   // bez preLaunchTask: jen nahrát
    const rc = new ReloadController();
    const subs = rc.register();
    startSession.fire(s.session);
    vs.workspace.getConfiguration = () => ({ get: (k: string, d: any) => (k === 'reloadOnSave' ? true : d) });

    const run = rc.reload(s.session);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(rc.isBusy(), true);
    assert.equal(await rc.reload(s.session), false);
    assert.match(msgs.at(-1)!, /^info:/);
    // uložení zdrojáku během nahrávání → po dokončení ještě jednou; jiný soubor nic
    saveDocument.fire({ fileName: 'C:/ws/prog.txt', uri: {} });
    saveDocument.fire({ fileName: 'C:/ws/prog.asm', uri: {} });
    s.finish();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(s.calls, ['reload', 'reload']);
    s.finish();
    assert.equal(await run, true);
    assert.equal(rc.isBusy(), false);

    // uložení mimo reload: s odkladem jeden reload i pro víc souborů (Uložit vše)
    saveDocument.fire({ fileName: 'C:/ws/a.asm', uri: {} });
    saveDocument.fire({ fileName: 'C:/ws/b.inc', uri: {} });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(s.calls, ['reload', 'reload', 'reload']);
    s.finish();
    await new Promise((r) => setTimeout(r, 5));
    // vypnuté nastavení: nic
    vs.workspace.getConfiguration = () => ({ get: (_k: string, d: any) => d });
    saveDocument.fire({ fileName: 'C:/ws/a.asm', uri: {} });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.calls.length, 3);
    for (const d of subs) d.dispose();
});
