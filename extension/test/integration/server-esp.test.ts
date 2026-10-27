// WiFi: emulovaný modul ESP-01 na UART 0 (launch `esp`, `espAllowedHosts`, `espListenAddress`,
// `espIpAddress`). Fixture test/fixtures/uart.asm je most mezi pamětí a UART: test zapisuje příkazy
// AT do `tx_len`/`tx_buf` a čte odpovědi z `rx_buf`. Spojení míří na malý server HTTP na adrese
// tohoto počítače v místní síti (smyčku 127.0.0.1 modul odmítá vždy); bez takové adresy se test
// přeskočí.
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { ServerConnection, ServerEvent } from '../../src/server';
import { espArgs } from '../../src/session';
import { t } from '../../src/i18n';
import { DapClient, FIXTURES, NO_SERVER, SERVER, sleep } from './dap-client';

const PROGRAM = path.join(FIXTURES, 'uart.nex');

/** IPv4 adresa tohoto počítače v soukromé síti (10/8, 172.16/12, 192.168/16). */
function lanAddress(): string | undefined {
    for (const list of Object.values(os.networkInterfaces()))
        for (const a of list ?? []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            const [x, y] = a.address.split('.').map(Number);
            if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return a.address;
        }
    return undefined;
}
const LAN = lanAddress();
const SKIP = NO_SERVER || (LAN ? false : 'počítač nemá adresu v soukromé síti');

/** Adresa návěští ze SLD fixture. */
function label(name: string): number {
    const line = fs.readFileSync(path.join(FIXTURES, 'uart.sld'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(`|F|${name}`));
    return Number(line!.split('|')[5]);
}

type Request = (cmd: string, args?: Record<string, any>) => Promise<any>;

/** Příkazy AT přes fixture uart.nex (stroj musí běžet). */
class Uart {
    private seen = 0;
    private readonly txLen = label('tx_len');
    private readonly rxLen = label('rx_len');
    private readonly rxBuf = label('rx_buf');
    constructor(private readonly req: Request) {}

    private async read(addr: number, length: number): Promise<Buffer> {
        return Buffer.from((await this.req('readMemory', { addr, length })).data, 'base64');
    }

    /** Co od minule přišlo z UART. */
    async rx(): Promise<string> {
        const n = (await this.read(this.rxLen, 2)).readUInt16LE(0);
        const data = n > this.seen ? await this.read(this.rxBuf + this.seen, n - this.seen) : Buffer.alloc(0);
        this.seen = n;
        return data.toString('latin1');
    }

    async send(text: string): Promise<void> {
        const deadline = Date.now() + 5000;
        while ((await this.read(this.txLen, 2)).readUInt16LE(0) !== 0) {
            assert.ok(Date.now() < deadline, 'program bajty do UART neodeslal');
            await sleep(10);
        }
        const bytes = Buffer.from(text, 'latin1');
        const len = Buffer.alloc(2);
        len.writeUInt16LE(bytes.length);
        await this.req('writeMemory', { addr: this.txLen, data: Buffer.concat([len, bytes]).toString('base64') });
    }

    /** Pošle text a čeká na odpověď, která splní `until` (výchozí výsledek OK / ERROR). */
    async at(text: string, until = /\r\n(OK|ERROR)\r\n/, ms = 5000): Promise<string> {
        await this.send(text);
        let got = '';
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && !until.test(got)) {
            await sleep(20);
            got += await this.rx();
        }
        return got;
    }
}

async function startServer(): Promise<{ s: ServerConnection; events: ServerEvent[] }> {
    const s = new ServerConnection(SERVER, FIXTURES);
    const events: ServerEvent[] = [];
    await new Promise<void>((resolve) =>
        s.on('event', (e: ServerEvent) => {
            events.push(e);
            if (e.event === 'ready') resolve();
        }),
    );
    return { s, events };
}

/** Program běží (nahrává se po pár snímcích): smyčka `loop` je v paměti. */
async function running(req: Request): Promise<void> {
    const loop = label('loop');
    const deadline = Date.now() + 10000;
    for (;;) {
        const r = await req('registers');
        if (r.registers.PC >= label('start') && r.registers.PC < label('tx_pos')) return;
        assert.ok(Date.now() < deadline, `program neběží (PC $${r.registers.PC.toString(16)}, loop $${loop.toString(16)})`);
        await sleep(50);
    }
}

describe('WiFi (ESP-01 na UART 0)', { skip: SKIP, timeout: 120000 }, () => {
    let web: http.Server;
    let port = 0;
    before(async () => {
        web = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
            res.end(`Ahoj z PC: ${req.method} ${req.url}\n`);
        });
        await new Promise<void>((resolve) => web.listen(0, LAN, resolve));
        port = (web.address() as AddressInfo).port;
    });
    after(() => web?.close());

    test('výchozí: modul vypnutý, na AT nikdo neodpoví OK', async () => {
        const { s } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await req('launch', { program: PROGRAM, machine: 'next' });
            await running(req);
            const u = new Uart(req);
            const r = await u.at('AT\r\n', /OK/, 1500);
            assert.doesNotMatch(r, /OK/);
        } finally {
            s.close();
        }
    });

    test('esp: AT, AT+CWJAP? připojeno, HTTP GET na adresu v místní síti → +IPD, smyčka odmítnuta; nový launch bez esp modul vypne', async () => {
        const { s, events } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await req('launch', { program: PROGRAM, machine: 'next', esp: true, espIpAddress: '10.1.2.3' });
            const info = events.find((e) => e.event === 'output' && e.key === 'espEnabled');
            assert.ok(info, 'hlášení espEnabled');
            await running(req);
            const u = new Uart(req);
            assert.match(await u.at('AT\r\n'), /\r\nOK\r\n/);
            assert.match(await u.at('AT+CWJAP?\r\n'), /\+CWJAP:"[^"]+".*\r\n\r\nOK\r\n/s);
            assert.match(await u.at('AT+CIFSR\r\n'), /\+CIFSR:STAIP,"10\.1\.2\.3"/);
            // smyčka a localhost: zakázané vždy (esp::AddressPolicy), i bez espAllowedHosts
            assert.match(await u.at(`AT+CIPSTART="TCP","127.0.0.1",${port}\r\n`), /ERROR/);
            assert.match(await u.at(`AT+CIPSTART="TCP","localhost",${port}\r\n`), /ERROR/);
            assert.match(await u.at(`AT+CIPSTART="TCP","${LAN}",${port}\r\n`), /\r\nOK\r\n/);
            const get = `GET /nmail HTTP/1.0\r\nHost: ${LAN}\r\n\r\n`;
            assert.match(await u.at(`AT+CIPSEND=${get.length}\r\n`, />/), /OK\r\n> ?/);
            const r = await u.at(get, /CLOSED/, 8000);
            assert.match(r, /SEND OK/);
            assert.match(r, /\+IPD,\d+:HTTP\/1\.[01] 200/);
            assert.match(r, /Ahoj z PC: GET \/nmail/);
            // nový launch (restart sezení) bez esp: studený start s novou konfigurací, modul zmizí
            await req('launch', { program: PROGRAM, machine: 'next' });
            await sleep(300);
            await running(req);
            const u2 = new Uart(req);
            assert.doesNotMatch(await u2.at('AT\r\n', /OK/, 1500), /OK/);
        } finally {
            s.close();
        }
    });

    test('espAllowedHosts: jiný host odmítne, hlášení vypíše seznam; neplatná espListenAddress → chyba launch', async () => {
        const { s, events } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await assert.rejects(req('launch', { program: PROGRAM, esp: true, espListenAddress: 'localhost' }), /espListenAddress/);
            await assert.rejects(req('launch', { program: PROGRAM, esp: true, espAllowedHosts: [' '] }), /espAllowedHosts/);
            await req('launch', { program: PROGRAM, machine: 'next', esp: true, espAllowedHosts: ['example.invalid'] });
            const info = events.find((e) => e.event === 'output' && e.key === 'espEnabledHosts');
            assert.deepEqual(info?.args, ['example.invalid']);
            await running(req);
            const u = new Uart(req);
            assert.match(await u.at(`AT+CIPSTART="TCP","${LAN}",${port}\r\n`), /ERROR/);
        } finally {
            s.close();
        }
    });

    test('espLog: záznam provozu oběma směry po kusech (řádcích), since, espClear; espState s událostmi spojení', async () => {
        const { s } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await req('launch', { program: PROGRAM, machine: 'next', esp: true, espIpAddress: '10.1.2.3' });
            await running(req);
            const empty = await req('espLog');
            assert.equal(empty.enabled, true);
            const u = new Uart(req);
            assert.match(await u.at('AT\r\n'), /\r\nOK\r\n/);
            assert.match(await u.at(`AT+CIPSTART="TCP","${LAN}",${port}\r\n`), /\r\nOK\r\n/);
            const log = await req('espLog', { since: empty.next });
            const lines = log.entries.map((e: any) => e.dir + ':' + Buffer.from(e.data, 'base64').toString('latin1'));
            assert.ok(lines.includes('tx:AT\r\n'), lines.join('|'));
            assert.ok(lines.includes(`tx:AT+CIPSTART="TCP","${LAN}",${port}\r\n`), lines.join('|'));
            assert.ok(lines.some((l: string) => l.startsWith('rx:') && l.includes('OK')), lines.join('|'));
            // pořadí: příkaz před odpovědí, seq bez děr, snímky neklesají
            const seqs = log.entries.map((e: any) => e.seq);
            assert.deepEqual(seqs, seqs.map((_: any, i: number) => seqs[0] + i));
            assert.ok(log.entries.every((e: any, i: number) => i === 0 || e.frame >= log.entries[i - 1].frame));
            assert.ok(lines.indexOf('tx:AT\r\n') < lines.findIndex((l: string) => l.startsWith('rx:') && l.includes('OK')));
            assert.ok(log.bytesTx >= 4 && log.bytesRx > 0);
            // since = poslední seq: vrátí jen poslední kus (může ještě růst)
            const tail = await req('espLog', { since: log.next - 1 });
            assert.equal(tail.entries.length, 1);
            const st = await req('espState');
            assert.equal(st.enabled, true);
            assert.equal(st.associated, true);
            assert.equal(st.stationIp, '10.1.2.3');
            assert.ok(st.events.some((e: any) => e.kind === 'opened' && e.host === LAN && e.port === port), JSON.stringify(st.events));
            await u.at('AT+CIPCLOSE\r\n', /CLOSED|OK/);
            await req('espClear');
            const cleared = await req('espLog');
            assert.equal(cleared.entries.length, 0);
            assert.equal(cleared.first, cleared.next);
            assert.notEqual(cleared.epoch, log.epoch, 'espClear mění epoch');
            assert.ok(cleared.next >= log.next, 'seq po espClear pokračuje');
            // tvrdý reset (stroj se sestaví znovu, nový adaptér) záznam nemaže a odposlech se vloží znovu;
            // že nový adaptér opravdu odposlouchává, ukazuje už launch (také studený start)
            await u.at('AT\r\n');
            await req('reset', { hard: true });
            await sleep(300);
            const after = await req('espLog');
            assert.equal(after.enabled, true);
            assert.ok(after.entries.some((e: any) => Buffer.from(e.data, 'base64').toString('latin1') === 'AT\r\n'));
        } finally {
            s.close();
        }
    });

    test('espLog / espState bez esp: enabled false, nic se nezaznamená', async () => {
        const { s } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await req('launch', { program: PROGRAM, machine: 'next' });
            await running(req);
            await new Uart(req).at('AT\r\n', /OK/, 500);
            const log = await req('espLog');
            assert.equal(log.enabled, false);
            assert.equal(log.entries.length, 0);
            assert.deepEqual(await req('espState').then((r) => r.enabled), false);
        } finally {
            s.close();
        }
    });

    test('breakpoint espTx / espRx: zastaví instrukce, která řádek dokončila, podle vzoru; neplatný regex neověřen', async () => {
        const { s, events } = await startServer();
        try {
            const req: Request = (c, a) => s.request(c, a);
            await req('launch', { program: PROGRAM, machine: 'next', esp: true });
            await running(req);
            const u = new Uart(req);
            const r = await req('setEventBreakpoints', {
                events: [
                    { id: 1, kind: 'espTx', condition: 'cipstart' },
                    { id: 2, kind: 'espRx', condition: '/^\\+CWJAP:/' },
                    { id: 3, kind: 'espRx', condition: '/(/' },
                ],
            });
            assert.deepEqual(r.events.map((e: any) => e.verified), [true, true, false]);
            assert.match(r.events[2].message, /regular expression/);
            const stopped = (from: number) => events.slice(from).find((e) => e.event === 'stopped');
            const waitStop = async (from: number) => {
                const deadline = Date.now() + 5000;
                while (!stopped(from)) {
                    assert.ok(Date.now() < deadline, 'nezastavil');
                    await sleep(20);
                }
                return stopped(from)!;
            };
            // příkaz, který vzoru neodpovídá, nezastaví
            assert.match(await u.at('AT\r\n'), /\r\nOK\r\n/);
            assert.equal(stopped(0), undefined);
            let from = events.length;
            await u.send(`AT+CIPSTART="TCP","${LAN}",${port}\r\n`);
            let e = await waitStop(from);
            assert.equal(e.reason, 'event');
            assert.equal(e.eventKind, 'espTx');
            assert.equal(e.text, `Z80 → ESP: AT+CIPSTART="TCP","${LAN}",${port}`);
            // stojí v kódu fixture, který bajty posílá (OUT na $133B)
            assert.ok(e.pc >= label('start') && e.pc < label('tx_pos'), `PC $${e.pc.toString(16)}`);
            await req('continue');
            from = events.length;
            await u.send('AT+CWJAP?\r\n');
            e = await waitStop(from);
            assert.equal(e.eventKind, 'espRx');
            assert.match(e.text, /^ESP → Z80: \+CWJAP:"/);
            await req('continue');
            await req('setEventBreakpoints', { events: [] });
        } finally {
            s.close();
        }
    });

    test('DAP: launch.json esp a espAllowedHosts dojdou na server, hlášení v Debug Console přeložené', async () => {
        const c = new DapClient('cs');
        try {
            await c.launch({ program: PROGRAM, esp: true, espAllowedHosts: [LAN] });
            const text = c.outputs().map((e) => e.body.output).join('');
            assert.ok(text.includes(t('session.serverEspEnabledHosts', LAN!)), text);
            await c.ok('continue', { threadId: 1 });
            const req: Request = (cmd, a) => c.server(cmd, a);
            const u = new Uart(req);
            assert.match(await u.at('AT\r\n'), /\r\nOK\r\n/);
            assert.match(await u.at(`AT+CIPSTART="TCP","${LAN}",${port}\r\n`), /\r\nOK\r\n/);
            assert.match(await u.at('AT+CIPCLOSE\r\n'), /CLOSED|OK/);
        } finally {
            await c.close();
        }
    });
});

test('espArgs: bez esp nic, s esp jen zadané volby', () => {
    const base = { program: 'x.nex' };
    assert.deepEqual(espArgs({ ...base }), {});
    assert.deepEqual(espArgs({ ...base, esp: false, espAllowedHosts: ['a'] }), {});
    assert.deepEqual(espArgs({ ...base, esp: true }), { esp: true });
    assert.deepEqual(espArgs({ ...base, esp: true, espAllowedHosts: [], espListenAddress: '' }), { esp: true });
    assert.deepEqual(espArgs({ ...base, esp: true, espAllowedHosts: ['192.168.1.10', 'mail.example.org'], espListenAddress: '0.0.0.0', espIpAddress: '192.168.1.77' }), {
        esp: true,
        espAllowedHosts: ['192.168.1.10', 'mail.example.org'],
        espListenAddress: '0.0.0.0',
        espIpAddress: '192.168.1.77',
    });
});
