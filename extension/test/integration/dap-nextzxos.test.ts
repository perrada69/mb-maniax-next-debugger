// Start do NextZXOS (launch "boot": "nextzxos") přes DAP: karta připravená ze zipu oficiální
// distribuce, NextZXOS nabootuje z karty a examples/hello spustí autoexecem; debugger zastaví na
// první instrukci a teprve potom platí breakpointy. Na konci endSession (autoexec zpět, syncBack)
// a cleanCard. Distribuce není součástí repozitáře: zip z MBX_NEXTZXOS_ZIP nebo z dat rozšíření
// (příkaz Stáhnout NextZXOS), jinak se test přeskočí.
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerConnection } from '../../src/server';
import { DapClient, FIXTURES, lineOf, NO_SERVER, program, REPO, SERVER, sleep } from './dap-client';

const ZIP =
    process.env.MBX_NEXTZXOS_ZIP ||
    path.join(process.env.APPDATA ?? os.homedir(), 'Code', 'User', 'globalStorage', 'miroslavbursa.mbx-next-debugger', 'nextzxos', 'sn-emulator-24.11.zip');
const NO_ZIP: string | false = fs.existsSync(ZIP) ? false : `chybí distribuce NextZXOS ${ZIP} (MBX_NEXTZXOS_ZIP)`;
const SKIP = NO_SERVER || NO_ZIP;
const hello = program('hello', path.join(REPO, 'examples', 'hello'));
const WORK = path.join(os.tmpdir(), 'mbx-nextzxos-test');
const BASE = path.join(WORK, 'base.img');
const CARD = path.join(WORK, 'card.img');
const ROOT = path.join(WORK, 'root');

/** Jeden příkaz na samostatném serveru (příprava a čištění karty). */
async function serverCall(cmd: string, args: Record<string, any>): Promise<any> {
    const s = new ServerConnection(SERVER, WORK);
    try {
        await new Promise<void>((resolve) => s.on('event', (e) => e.event === 'ready' && resolve()));
        return await s.request(cmd, args);
    } finally {
        s.close();
    }
}

describe('DAP: start do NextZXOS', { skip: SKIP, timeout: 300000 }, () => {
    let c: DapClient;
    before(async () => {
        fs.mkdirSync(ROOT, { recursive: true });
        if (!fs.existsSync(BASE)) await serverCall('prepareSd', { zip: ZIP, sdImage: BASE });
        fs.copyFileSync(BASE, CARD);
        fs.copyFileSync(hello.program, path.join(ROOT, 'hello.nex'));
        fs.writeFileSync(path.join(ROOT, 'DATA.TXT'), 'data');
        c = new DapClient('en');
        await c.launch({
            program: path.join(ROOT, 'hello.nex'),
            sld: hello.sld,
            sourceRoot: hello.sourceRoot,
            boot: 'nextzxos',
            sdImage: CARD,
            esxdosRoot: ROOT,
            syncBack: true,
        });
    });
    after(async () => {
        await c?.close();
    });

    test('NextZXOS spustí program z karty a debugger zastaví na jeho první instrukci', async () => {
        const f = await c.top();
        assert.equal(f.name, 'start');
        assert.equal(f.instructionPointerReference, '0x8000');
        const out = c.outputs().map((e) => e.body.output).join('');
        assert.match(out, /file\(s\) copied to C:\/MBX\/hello on the SD card/);
        assert.match(out, /NextZXOS is starting from the SD card/);
    });

    test('breakpoint po vstupu platí v programu, ne v NextZXOS', async () => {
        const line = lineOf(hello.source, 'out ($fe), a');
        const bp = await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [{ line }] });
        assert.deepEqual(bp.breakpoints.map((b: any) => b.verified), [true]);
        await c.cont(20000);
        assert.match((await c.top()).name, /^next_colour/);
        await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [] });
    });

    test('endSession: program na kartě nic nezměnil, nic se nevrací; cleanCard smaže /MBX', async () => {
        const r = await c.server('endSession');
        assert.deepEqual(r.copied, []);
        assert.deepEqual(r.missing, []);
        await c.close();
        c = undefined as any;
        const cleaned = await serverCall('cleanCard', { sdImage: CARD, folder: '/MBX' });
        assert.equal(cleaned.ok, true);
    });
});

describe('DAP: start do NextZXOS se syncBack', { skip: SKIP, timeout: 300000 }, () => {
    const root = path.join(WORK, 'writer');
    test('soubory, které program na kartě vytvořil nebo změnil, se vrátí; smazaný se jen vypíše', async () => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        if (!fs.existsSync(BASE)) await serverCall('prepareSd', { zip: ZIP, sdImage: BASE });
        fs.copyFileSync(BASE, CARD);
        fs.copyFileSync(path.join(FIXTURES, 'writer.nex'), path.join(root, 'writer.nex'));
        fs.writeFileSync(path.join(root, 'DATA.TXT'), 'data');
        fs.writeFileSync(path.join(root, 'OLD.TXT'), 'old');
        const c = new DapClient('en');
        try {
            await c.launch({ program: path.join(root, 'writer.nex'), sld: path.join(FIXTURES, 'writer.sld'), sourceRoot: FIXTURES, boot: 'nextzxos', sdImage: CARD, syncBack: true });
            await c.ok('continue', { threadId: 1 });
            const done = c.session.getSld()!.label('done')!.addr;
            for (let i = 0; i < 100 && (await c.server('readMemory', { addr: done, length: 1 })).data !== 'AQ=='; ++i) await sleep(100);
            const r = await c.server('endSession');
            assert.deepEqual([...r.copied].sort(), ['DATA.TXT', 'NEW.TXT']);
            assert.deepEqual(r.missing, ['OLD.TXT']);
            assert.equal(fs.readFileSync(path.join(root, 'DATA.TXT'), 'utf8'), 'data2');
            assert.equal(fs.readFileSync(path.join(root, 'NEW.TXT'), 'utf8'), 'fresh');
            assert.equal(fs.readFileSync(path.join(root, 'OLD.TXT'), 'utf8'), 'old');
        } finally {
            await c.close();
        }
    });
});
