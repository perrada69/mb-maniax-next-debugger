// Samostatný adaptér src/adapter.ts (DAP přes stdin/stdout, server z MBX_NEXT_SERVER) jako
// podproces: initialize, launch se zastavením na vstupu, threads, stackTrace, evaluate, disconnect.
// Adaptér sestavuje test/build.mjs do out-test/adapter.js (vždy ze současného src, ne dist/).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES, NO_SERVER, REPO, SERVER } from './dap-client';

const adapter = path.join(__dirname, 'adapter.js');
const noAdapter = !fs.existsSync(adapter) && `chybí ${adapter} (sestavuje test/build.mjs)`;

/** Adaptér jako podproces s parserem zpráv DAP. */
function startAdapter(server: string) {
    const proc = spawn(process.execPath, [adapter], { env: { ...process.env, MBX_NEXT_SERVER: server, MBX_NEXT_LANG: 'en' }, stdio: 'pipe' });
    let buf = Buffer.alloc(0);
    let seq = 1;
    const pending = new Map<number, (m: any) => void>();
    const events: any[] = [];
    const waiters: Array<{ name: string; resolve: (m: any) => void }> = [];
    proc.stdout.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
            const h = buf.indexOf('\r\n\r\n');
            if (h < 0) return;
            const len = +/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())![1];
            if (buf.length < h + 4 + len) return;
            const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString('utf8'));
            buf = buf.subarray(h + 4 + len);
            if (msg.type === 'response') pending.get(msg.request_seq)?.(msg);
            else {
                events.push(msg);
                const i = waiters.findIndex((w) => w.name === msg.event);
                if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
            }
        }
    });
    return {
        proc,
        events,
        exited: new Promise<number | null>((r) => proc.on('exit', r)),
        send: (command: string, args: any = {}) =>
            new Promise<any>((resolve) => {
                const s = seq++;
                pending.set(s, resolve);
                const body = JSON.stringify({ seq: s, type: 'request', command, arguments: args });
                proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            }),
        event: (name: string) => {
            const seen = events.find((e) => e.event === name);
            return seen ? Promise.resolve(seen) : new Promise<any>((resolve) => waiters.push({ name, resolve }));
        },
    };
}
const INIT = { adapterID: 'mbx-next', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true };

test('adaptér (src/adapter.ts): spuštění hello, zásobník, evaluate, konec', { skip: NO_SERVER || noAdapter, timeout: 30000 }, async () => {
    const a = startAdapter(SERVER);
    try {
        const init = await a.send('initialize', INIT);
        assert.ok(init.success && init.body.supportsConfigurationDoneRequest, JSON.stringify(init));
        const source = path.join(REPO, 'examples', 'hello', 'hello.asm');
        const launch = await a.send('launch', { program: path.join(FIXTURES, 'hello.nex'), sld: path.join(FIXTURES, 'hello.sld'), sourceRoot: path.dirname(source), stopOnEntry: true });
        assert.ok(launch.success, launch.message);
        await a.event('initialized');
        const stopped = a.event('stopped');
        await a.send('configurationDone');
        assert.equal((await stopped).body.reason, 'entry');
        assert.equal((await a.send('threads')).body.threads.length, 1);
        const st = await a.send('stackTrace', { threadId: 1 });
        assert.equal(st.body.stackFrames[0].name, 'start');
        assert.equal(path.basename(st.body.stackFrames[0].source.path), 'hello.asm');
        const ev = await a.send('evaluate', { expression: 'PC', context: 'watch' });
        assert.equal(ev.body.result.split(' ')[0], '$8000');
        await a.send('disconnect', {});
        const code = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
        assert.notEqual(code, 'timeout', 'adaptér po disconnect skončí');
    } finally {
        a.proc.kill();
    }
});

test('adaptér bez serveru: launch selže s chybou a ukončí sezení', { skip: noAdapter, timeout: 15000 }, async () => {
    const missing = path.join(REPO, 'neexistuje.exe');
    const a = startAdapter(missing);
    try {
        assert.ok((await a.send('initialize', INIT)).success);
        const launch = await a.send('launch', { program: path.join(FIXTURES, 'hello.nex') });
        assert.equal(launch.success, false);
        assert.ok(launch.message.includes(missing), launch.message);
        await a.event('terminated');
    } finally {
        a.proc.kill();
    }
});
