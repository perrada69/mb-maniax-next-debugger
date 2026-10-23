// Server: paprsek (raster), zvuk (soundState), obsazení paměti (pageUsage) a úklid výpisů
// v Debug Console – proti skutečnému serveru na examples/hello (okraj mění OUT ($FE)).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ServerConnection, ServerEvent } from '../../src/server';

const root = path.resolve(__dirname, '..', '..');
const exe = path.join(root, 'build', 'release', 'bin', 'mbx-next-server.exe');
const program = path.join(root, 'examples', 'hello', 'hello.nex');
const rom = path.join(root, 'extension', 'media', '48.rom');
const missing = !fs.existsSync(exe) ? `chybí server ${exe}` : !fs.existsSync(program) ? `chybí ${program}` : false;

/** Server s hello zastaveným na vstupu; `console` = co by rozšíření ukázalo v Debug Console. */
async function start(): Promise<{ server: ServerConnection; console: string[]; outputs: ServerEvent[]; next: (pred: (e: ServerEvent) => boolean) => Promise<ServerEvent> }> {
    const server = new ServerConnection(exe, path.dirname(program));
    const consoleLines: string[] = [];
    const outputs: ServerEvent[] = [];
    const waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
    server.on('stderr', (t: string) => consoleLines.push(t));
    server.on('event', (e: ServerEvent) => {
        if (e.event === 'output') {
            outputs.push(e);
            consoleLines.push(e.text);
        }
        const i = waiters.findIndex((w) => w.pred(e));
        if (i >= 0) waiters.splice(i, 1)[0].resolve(e);
    });
    const next = (pred: (e: ServerEvent) => boolean) =>
        new Promise<ServerEvent>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('událost nepřišla')), 15000);
            waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) });
        });
    await next((e) => e.event === 'ready');
    const entry = next((e) => e.event === 'stopped' && e.reason === 'entry');
    await server.request('launch', { program, machine: 'next', stopOnEntry: true, ...(fs.existsSync(rom) ? { rom } : {}) });
    await entry;
    return { server, console: consoleLines, outputs, next };
}

const opts = { skip: missing, timeout: 60000 };

test('raster: pozice paprsku odpovídá čítačům a stavu stroje', opts, async () => {
    const { server, next } = await start();
    try {
        // Konec snímku: poslední řádek obrazu (vc 287 = řádek 255 na Nextu 50 Hz).
        const stop = next((e) => e.event === 'stopped');
        await server.request('runToEndOfFrame');
        await stop;
        let r = await server.request('raster');
        let s = await server.request('state');
        assert.equal(r.linesPerFrame, 311);
        assert.equal(r.vc, 287);
        assert.equal(r.y, 255);
        assert.equal(r.frame, s.frame);
        assert.equal(r.cycleInFrame, s.cycleInFrame);
        assert.ok(r.x >= -1 && r.x < 320);

        // Zápis okraje (OUT ($FE)) uprostřed snímku: y = vc − 32 v obraze, jinak −1.
        await server.request('setEventBreakpoints', { events: [{ id: 1, kind: 'port', mask: 0xff, value: 0xfe, access: 'write' }] });
        const hit = next((e) => e.event === 'stopped');
        await server.request('continue');
        assert.equal((await hit).reason, 'event');
        r = await server.request('raster');
        s = await server.request('state');
        for (const k of ['vc', 'hc', 'x', 'y', 'frame', 'cycleInFrame', 'linesPerFrame']) assert.equal(typeof r[k], 'number', k);
        assert.equal(r.y, r.vc - 32 >= 0 && r.vc - 32 < 256 ? r.vc - 32 : -1);
        assert.ok(r.x >= -1 && r.x < 320);
        assert.ok(r.vc >= 0 && r.vc < r.linesPerFrame);
        assert.equal(r.frame, s.frame);
        assert.equal(r.cycleInFrame, s.cycleInFrame);
        // 28 MHz cykly ve snímku = 4 × (vc × 456 + hc) (+1), 456 tiků na řádek u Nextu 50 Hz.
        assert.ok(Math.abs(r.cycleInFrame - 4 * (r.vc * 456 + r.hc)) <= 4, JSON.stringify(r));
    } finally {
        server.close();
    }
});

test('soundState: tři AY po 16 registrech, TurboSound, režim a DAC', opts, async () => {
    const { server } = await start();
    try {
        const r = await server.request('soundState');
        assert.equal(r.chips.length, 3);
        for (const c of r.chips) {
            assert.equal(c.regs.length, 16);
            for (const v of c.regs) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255);
        }
        assert.equal(typeof r.turbosound, 'boolean');
        assert.ok(['AY', 'YM', 'reset'].includes(r.ayMode), r.ayMode);
        assert.ok(r.dac === null || (r.dac.length === 4 && r.dac.every((v: number) => v >= 0 && v <= 255)));
    } finally {
        server.close();
    }
});

test('pageUsage: 224 stránek, zápis do prázdné stránky se projeví, rychle', opts, async () => {
    const { server } = await start();
    try {
        let t0 = Date.now();
        const a = await server.request('pageUsage');
        const ms = Date.now() - t0;
        assert.equal(a.nonzero.length, 224);
        assert.ok(Array.isArray(a.rom));
        for (const v of a.nonzero) assert.ok(Number.isInteger(v) && v >= -1 && v <= 8192);
        assert.ok(a.nonzero[4] + a.nonzero[5] > 0, 'program na $8000 (stránky 4–5)');
        assert.ok(ms < 500, `${ms} ms`);
        const page = a.nonzero.findIndex((v: number, i: number) => i > 16 && v === 0);
        assert.ok(page > 0, 'prázdná stránka');
        await server.request('writeMemory', { addr: 0x100, page, data: Buffer.alloc(16, 0xa5).toString('base64') });

        const b = await server.request('pageUsage');
        assert.equal(b.nonzero[page], 16);
    } finally {
        server.close();
    }
});

test('Debug Console po launch a resetu bez šumu JNEXT, esxDOS jednou s klíčem', opts, async () => {
    const { server, console: lines, outputs, next } = await start();
    try {
        const reset = next((e) => e.event === 'reset');
        await server.request('reset', { hard: true });
        await reset;
        await server.request('setRegister', { name: 'BC', value: 0x1234 });
        await server.request('writeMemory', { addr: 0x8000, data: Buffer.from([1, 2, 3]).toString('base64') });
        await new Promise((r) => setTimeout(r, 500));
        const all = lines.join('');
        assert.doesNotMatch(all, /no SD image is mounted/);
        assert.doesNotMatch(all, /esxdos-stub-writable/);
        assert.doesNotMatch(all, /MUTATE/);
        const info = outputs.filter((o) => o.key === 'esxdosWritable');
        assert.equal(info.length, 1);
        assert.equal(path.resolve(info[0].args[0]), path.dirname(program));
        assert.match(info[0].text, /\n$/);
    } finally {
        server.close();
    }
});

test('launch v pauze: program se nahraje a stroj zastaví na vstupu bez continue', opts, async () => {
    const { server, next } = await start();   // stojí na vstupu (pauza)
    try {
        const s0 = await server.request('state');
        assert.equal(s0.paused, true);
        // Znovu launch, stroj pořád stojí: server se má rozběhnout sám a znovu zastavit na vstupu.
        const entry = next((e) => e.event === 'stopped' && e.reason === 'entry');
        await server.request('launch', { program, machine: 'next', stopOnEntry: true, ...(fs.existsSync(rom) ? { rom } : {}) });
        const e = await entry;
        assert.equal(typeof e.pc, 'number');
        const s1 = await server.request('state');
        assert.equal(s1.paused, true);
        assert.equal(s1.pc, s0.pc, 'stojí na stejném vstupu programu');
    } finally {
        server.close();
    }
});
