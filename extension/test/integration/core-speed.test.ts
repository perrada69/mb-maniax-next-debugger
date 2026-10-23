// Jádro proti skutečnému serveru (protokol docs/protocol.md přímo, bez rozšíření): rychlost
// emulace se zapnutým ladicím backendem a magic breakpoint FD 00 (BREAK ze sjasmplus / CSpect 2.x).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Výstup testů je plochý (extension/out-test/core-speed.test.js): '..' = extension, '..', '..' = kořen.
const ext = path.join(__dirname, '..');
const root = path.join(__dirname, '..', '..');
const server = path.join(root, 'build', 'release', 'bin', process.platform === 'win32' ? 'mbx-next-server.exe' : 'mbx-next-server');
const rom = path.join(ext, 'media', '48.rom');
const hello = [path.join(ext, 'test', 'fixtures', 'hello.nex'), path.join(root, 'examples', 'hello', 'hello.nex')].find((p) => fs.existsSync(p)) ?? path.join(ext, 'test', 'fixtures', 'hello.nex');
const noServer = !fs.existsSync(server) ? `chybí server ${server}` : false;

/** Spojení se serverem: rámce [u32 délka][u8 typ][data], typ 1 = JSON. */
class Server {
    private proc: ChildProcess;
    private buf = Buffer.alloc(0);
    private id = 0;
    private pending = new Map<number, (m: any) => void>();
    readonly events: any[] = [];
    private waiters: Array<{ match: (e: any) => boolean; resolve: (e: any) => void }> = [];

    constructor(cwd: string) {
        this.proc = spawn(server, [], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        this.proc.stdout!.on('data', (d: Buffer) => {
            this.buf = Buffer.concat([this.buf, d]);
            while (this.buf.length >= 5) {
                const len = this.buf.readUInt32LE(0);
                if (this.buf.length < 4 + len) break;
                const type = this.buf[4];
                const body = this.buf.subarray(5, 4 + len);
                this.buf = this.buf.subarray(4 + len);
                if (type !== 1) continue;
                const m = JSON.parse(body.toString('utf8'));
                if (m.id !== undefined) {
                    this.pending.get(m.id)?.(m);
                    this.pending.delete(m.id);
                } else {
                    this.events.push(m);
                    for (const w of [...this.waiters]) {
                        if (w.match(m)) {
                            this.waiters.splice(this.waiters.indexOf(w), 1);
                            w.resolve(m);
                        }
                    }
                }
            }
        });
    }

    request(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
        const id = ++this.id;
        const body = Buffer.from(JSON.stringify({ ...args, cmd, id }));
        const head = Buffer.alloc(5);
        head.writeUInt32LE(body.length + 1);
        head[4] = 1;
        this.proc.stdin!.write(Buffer.concat([head, body]));
        return new Promise((resolve) => this.pending.set(id, resolve));
    }

    /** Událost, která vyhoví (i ta, co už přišla). */
    event(match: (e: any) => boolean, ms = 10000): Promise<any> {
        const old = this.events.find(match);
        if (old) return Promise.resolve(old);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('událost nepřišla')), ms);
            this.waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
        });
    }

    async close(): Promise<void> {
        const exited = new Promise<void>((r) => this.proc.once('exit', () => r()));
        try {
            await Promise.race([this.request('quit'), sleep(500)]);
        } catch {
            // server už skončil
        }
        await Promise.race([exited, sleep(2000)]);
        if (this.proc.exitCode === null) this.proc.kill();
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** NEX V1.2 s jedinou bankou 2 (0x8000–0xBFFF): `code` od 0x8000, PC = 0x8000. */
function nex(code: number[]): Buffer {
    const head = Buffer.alloc(512);
    head.write('NextV1.2', 0, 'latin1');
    head[9] = 1;                    // počet bank
    head.writeUInt16LE(0xbff0, 12); // SP
    head.writeUInt16LE(0x8000, 14); // PC
    head[18 + 2] = 1;               // banka 2
    head[135] = 3;                  // jádro 3.0.0
    const bank = Buffer.alloc(0x4000);
    Buffer.from(code).copy(bank);
    return Buffer.concat([head, bank]);
}

test('rychlost: hello běží se zapnutým ladicím backendem aspoň 45 snímků/s', { skip: noServer || (!fs.existsSync(hello) && `chybí ${hello}`), timeout: 30000 }, async () => {
    const s = new Server(path.dirname(hello));
    try {
        await s.event((e) => e.event === 'ready');
        const r = await s.request('launch', { program: hello, machine: 'next', stopOnEntry: false, rewind: false, rom });
        assert.equal(r.ok, true, r.error);
        await s.request('audio', { on: true });
        await sleep(1500);
        const a = await s.request('state');
        const t0 = performance.now();
        await sleep(4000);
        const b = await s.request('state');
        const fps = ((b.frame - a.frame) * 1000) / (performance.now() - t0);
        assert.equal(b.paused, false);
        assert.ok(fps >= 45, `jen ${fps.toFixed(1)} snímků/s`);
    } finally {
        await s.close();
    }
});

test('magic breakpoint: FD 00 (BREAK) zastaví stroj za instrukcí s důvodem magic', { skip: noServer, timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-fd00-'));
    // 8000 LD A,1 · 8002 FD 00 (BREAK) · 8004 LD A,2 · 8006 JR $
    const prog = path.join(dir, 'brk.nex');
    fs.writeFileSync(prog, nex([0x3e, 0x01, 0xfd, 0x00, 0x3e, 0x02, 0x18, 0xfe]));
    const s = new Server(dir);
    try {
        await s.event((e) => e.event === 'ready');
        const r = await s.request('launch', { program: prog, machine: 'next', stopOnEntry: false, rewind: false, rom, magicBreakpoint: true });
        assert.equal(r.ok, true, r.error);
        const stop = await s.event((e) => e.event === 'stopped');
        assert.equal(stop.reason, 'magic');
        assert.equal(stop.pc, 0x8004);
        const regs = await s.request('registers');
        assert.equal(regs.registers.PC, 0x8004);
        assert.equal(regs.registers.AF >> 8, 1, 'LD A,2 za BREAK ještě neproběhlo');
        // Dál běží bez dalšího zastavení až do JR $.
        await s.request('continue');
        await sleep(500);
        const st = await s.request('state');
        assert.equal(st.paused, false);
        assert.equal(s.events.filter((e) => e.event === 'stopped').length, 1);
        const after = await s.request('registers');
        assert.equal(after.registers.AF >> 8, 2);
    } finally {
        await s.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('magic breakpoint vypnutý: FD 00 je obyčejný NOP a stroj nezastaví', { skip: noServer, timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-fd00-'));
    const prog = path.join(dir, 'brk.nex');
    fs.writeFileSync(prog, nex([0x3e, 0x01, 0xfd, 0x00, 0x3e, 0x02, 0x18, 0xfe]));
    const s = new Server(dir);
    try {
        await s.event((e) => e.event === 'ready');
        const r = await s.request('launch', { program: prog, machine: 'next', stopOnEntry: false, rewind: false, rom, magicBreakpoint: false });
        assert.equal(r.ok, true, r.error);
        await sleep(1500);
        const st = await s.request('state');
        assert.equal(st.paused, false);
        assert.equal(s.events.filter((e) => e.event === 'stopped').length, 0);
        const regs = await s.request('registers');
        assert.equal(regs.registers.AF >> 8, 2);
        assert.equal(regs.registers.PC, 0x8006);
    } finally {
        await s.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
