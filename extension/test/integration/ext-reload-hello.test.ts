// Přeložit a nahrát znovu proti skutečnému serveru: examples/hello se přeloží do dočasné složky,
// spustí v NextDebugSession, do zdrojáku se přidá řádek, přeloží se znovu a po `reload` musí
// breakpoint stát na nové adrese své instrukce (a stroj se na ní zastavit).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextDebugSession } from '../../src/session';
import { SldInfo } from '../../src/sld';

const repo = path.join(__dirname, '..', '..');
const server = path.join(repo, 'build', 'release', 'bin', process.platform === 'win32' ? 'mbx-next-server.exe' : 'mbx-next-server');
const sjasmplus = process.env.SJASMPLUS || 'D:\\Source\\Assembler\\aswcurr\\bin\\sjasmplus.exe';
const skip = !fs.existsSync(server) ? `chybí server ${server}` : !fs.existsSync(sjasmplus) ? `chybí sjasmplus ${sjasmplus}` : false;

function build(dir: string): void {
    execFileSync(sjasmplus, ['--sld=hello.sld', '--fullpath', 'hello.asm'], { cwd: dir, stdio: 'pipe' });
}

/** Klient DAP nad sezením v procesu (jako DebugAdapterInlineImplementation ve VS Code). */
function client(session: NextDebugSession) {
    let seq = 1;
    const pending = new Map<number, (r: any) => void>();
    const events: any[] = [];
    const waiters: Array<{ match: (e: any) => boolean; resolve: (e: any) => void }> = [];
    session.onDidSendMessage((m: any) => {
        if (m.type === 'response') pending.get(m.request_seq)?.(m);
        else if (m.type === 'event') {
            events.push(m);
            for (const w of [...waiters]) {
                if (w.match(m)) {
                    waiters.splice(waiters.indexOf(w), 1);
                    w.resolve(m);
                }
            }
        }
    });
    return {
        events,
        request(command: string, args: any = {}): Promise<any> {
            const s = seq++;
            const p = new Promise<any>((r) => pending.set(s, r));
            session.handleMessage({ seq: s, type: 'request', command, arguments: args } as any);
            return p;
        },
        /** Další událost, která vyhoví (i ta, co už přišla od `since`). */
        event(match: (e: any) => boolean, since = 0, ms = 20000): Promise<any> {
            const old = events.slice(since).find(match);
            if (old) return Promise.resolve(old);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('událost nepřišla; přišly: ' + events.slice(since).map((e) => e.event + (e.body?.reason ? ':' + e.body.reason : '')).join(', '))), ms);
                waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
            });
        },
    };
}

test('reload: po přidání řádku a novém překladu se breakpoint posune na novou adresu', { skip, timeout: 90000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-reload-hello-'));
    const asm = path.join(dir, 'hello.asm');
    fs.copyFileSync(path.join(repo, 'examples', 'hello', 'hello.asm'), asm);
    build(dir);
    const src = fs.readFileSync(asm, 'utf8').split(/\r?\n/);
    const callLine = src.findIndex((l) => /^\s+call next_colour/.test(l)) + 1;   // od 1
    assert.ok(callLine > 0);
    const sldPath = path.join(dir, 'hello.sld');
    const oldAddr = SldInfo.load(sldPath).addressesFor(asm, callLine)!.addrs[0].addr;

    const session = new NextDebugSession(server);
    const c = client(session);
    try {
        await c.request('initialize', { adapterID: 'mbx-next', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
        const launch = await c.request('launch', { program: path.join(dir, 'hello.nex'), sld: sldPath, stopOnEntry: true });
        assert.equal(launch.success, true, launch.message);
        await c.event((e) => e.event === 'initialized');
        const set = await c.request('setBreakpoints', { source: { path: asm }, breakpoints: [{ line: callLine }] });
        const bp = set.body.breakpoints[0];
        assert.equal(bp.verified, true, bp.message);
        assert.equal(parseInt(bp.instructionReference, 16), oldAddr);
        await c.request('configurationDone');
        await c.event((e) => e.event === 'stopped' && e.body.reason === 'entry');

        // Nový řádek s instrukcí před voláním: `call` je o řádek níž a o bajt dál.
        src.splice(callLine - 1, 0, '        nop                     ; přidáno testem');
        fs.writeFileSync(asm, src.join('\n'));
        build(dir);
        const newLine = callLine + 1;
        const newAddr = SldInfo.load(sldPath).addressesFor(asm, newLine)!.addrs[0].addr;
        assert.equal(newAddr, oldAddr + 1);

        // VS Code po uložení posune breakpoint s textem a pošle nový řádek (ještě se starým SLD).
        const moved = await c.request('setBreakpoints', { source: { path: asm }, breakpoints: [{ line: newLine }] });
        const id = moved.body.breakpoints[0].id;
        const since = c.events.length;
        const r = await c.request('reload');
        assert.equal(r.success, true, r.message);

        const changed = c.events.slice(since).filter((e) => e.event === 'breakpoint' && e.body.breakpoint.id === id).at(-1);
        assert.ok(changed, 'událost breakpoint changed');
        assert.equal(changed.body.breakpoint.verified, true);
        assert.equal(changed.body.breakpoint.line, newLine);
        assert.equal(parseInt(changed.body.breakpoint.instructionReference, 16), newAddr);
        await c.event((e) => e.event === 'stopped' && e.body.reason === 'entry', since);

        // Rozběhnout: zastaví se na breakpointu na nové adrese.
        const before = c.events.length;
        await c.request('continue', { threadId: 1 });
        const stop = await c.event((e) => e.event === 'stopped' && e.body.reason === 'breakpoint', before);
        assert.deepEqual(stop.body.hitBreakpointIds, [id]);
        const st = await c.request('stackTrace', { threadId: 1 });
        const top = st.body.stackFrames[0];
        assert.equal(parseInt(top.instructionPointerReference, 16), newAddr);
        assert.equal(top.line, newLine);
        assert.equal(path.normalize(top.source.path).toLowerCase(), path.normalize(asm).toLowerCase());

        // Reload za běhu: stroj se tiše zastaví, nahraje se znovu a stojí na vstupu (stopOnEntry).
        await c.request('setBreakpoints', { source: { path: asm }, breakpoints: [] });
        await c.request('continue', { threadId: 1 });
        await new Promise((r) => setTimeout(r, 300));
        const since2 = c.events.length;
        const r2 = await c.request('reload');
        assert.equal(r2.success, true, r2.message);
        await c.event((e) => e.event === 'stopped' && e.body.reason === 'entry', since2);
        assert.ok(!c.events.slice(since2).some((e) => e.event === 'stopped' && e.body.reason !== 'entry'));
        const st2 = await c.request('stackTrace', { threadId: 1 });
        assert.equal(parseInt(st2.body.stackFrames[0].instructionPointerReference, 16), 0x8000);
    } finally {
        await c.request('disconnect', {});
        // server po `quit` končí až chvíli po odpovědi (drží složku jako pracovní adresář)
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
        } catch {
            // dočasná složka zůstane, test kvůli tomu neselže
        }
    }
});
