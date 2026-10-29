// Kempstonova myš: příkaz `mouse` (posun, tlačítka, kolečko) až do portů $FBDF / $FFDF / $FADF,
// stav myši v odpovědi na `state` (reads = program čte polohu → panel obrazovky zachytí myš).
// Fixture test/fixtures/mouse.asm každý snímek ukládá porty do mx, my, mb.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ServerConnection, ServerEvent } from '../../src/server';

const root = path.resolve(__dirname, '..', '..');
const exe = path.join(root, 'build', 'release', 'bin', 'mbx-next-server.exe');
const fixtures = path.join(root, 'extension', 'test', 'fixtures');
const program = path.join(fixtures, 'mouse.nex');
const rom = path.join(root, 'extension', 'media', '48.rom');
const missing = !fs.existsSync(exe) ? `chybí server ${exe}` : false;

/** Adresa návěští ze SLD fixture. */
function label(name: string): number {
    const line = fs.readFileSync(path.join(fixtures, 'mouse.sld'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(`|F|${name}`));
    return Number(line!.split('|')[5]);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('myš: posun, tlačítka a kolečko z příkazu mouse čte program na portech Kempstonovy myši', { skip: missing, timeout: 60000 }, async () => {
    const server = new ServerConnection(exe, fixtures);
    const ready = new Promise<void>((r) => server.on('event', (e: ServerEvent) => (e.event === 'ready' ? r() : undefined)));
    try {
        await ready;
        await server.request('launch', { program, machine: 'next', stopOnEntry: false, ...(fs.existsSync(rom) ? { rom } : {}) });
        await wait(300);
        const before = (await server.request('state')).mouse;
        assert.ok(before, 'state vrací mouse');
        assert.ok(before.reads > 0, 'program čte polohu myši');

        // VS Code / prohlížeč: buttons bit 0 levé, 1 pravé, 2 prostřední; dy > 0 = dolů
        server.send('mouse', { dx: 5, dy: 3, buttons: 1, wheel: -1 });
        await wait(300);
        await server.request('pause');
        const s = await server.request('state');
        const x = (before.x + 5) & 0xff;
        const y = (before.y - 3) & 0xff;   // Kempston: Y roste nahoru
        const wheel = (before.wheel - 1) & 0x0f;
        assert.deepEqual({ x: s.mouse.x, y: s.mouse.y, buttons: s.mouse.buttons, wheel: s.mouse.wheel }, { x, y, buttons: 2, wheel });
        assert.ok(s.mouse.reads > before.reads);

        const mx = label('mx');
        const mem = Buffer.from((await server.request('readMemory', { addr: mx, length: 3 })).data, 'base64');
        assert.equal(mem[0], x, 'port $FBDF');
        assert.equal(mem[1], y, 'port $FFDF');
        // $FADF: kolečko v bitech 7–4, bit 3 = 1, tlačítka aktivní v 0 (bit 1 levé)
        assert.equal(mem[2], (wheel << 4) | 0x08 | 0x05, 'port $FADF');

        // pravé + prostřední, kolečko zpět
        server.send('mouse', { buttons: 6, wheel: 1 });
        await server.request('continue');
        await wait(300);
        await server.request('pause');
        const mb = Buffer.from((await server.request('readMemory', { addr: mx + 2, length: 1 })).data, 'base64')[0];
        assert.equal(mb, (before.wheel << 4) | 0x08 | 0x02, 'pravé (bit 0) a prostřední (bit 2) stisknuté');
    } finally {
        server.close();
    }
});
