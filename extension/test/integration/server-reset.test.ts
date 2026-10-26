// Tvrdý reset vyvolaný programem (NR $02): bez SD karty server program nahraje znovu, stejně jako
// aplikace pro Android (jnext_android.cpp) – dřív zůstal stroj bez programu viset v ROM na $38.
// Fixture test/fixtures/hardreset.asm: po 50 snímcích reset, `runs` = počet spuštění od nahrání.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ServerConnection, ServerEvent } from '../../src/server';

const root = path.resolve(__dirname, '..', '..');
const exe = path.join(root, 'build', 'release', 'bin', 'mbx-next-server.exe');
const fixtures = path.join(root, 'extension', 'test', 'fixtures');
const program = path.join(fixtures, 'hardreset.nex');
const rom = path.join(root, 'extension', 'media', '48.rom');
const missing = !fs.existsSync(exe) ? `chybí server ${exe}` : false;

/** Adresa návěští ze SLD fixture. */
function label(name: string): number {
    const line = fs.readFileSync(path.join(fixtures, 'hardreset.sld'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(`|F|${name}`));
    return Number(line!.split('|')[5]);
}

test('tvrdý reset vyvolaný programem: program se nahraje znovu a běží dál', { skip: missing, timeout: 60000 }, async () => {
    const server = new ServerConnection(exe, fixtures);
    const resets: ServerEvent[] = [];
    const ready = new Promise<void>((r) => server.on('event', (e: ServerEvent) => (e.event === 'ready' ? r() : e.event === 'reset' ? void resets.push(e) : undefined)));
    try {
        await ready;
        await server.request('launch', { program, machine: 'next', stopOnEntry: false, ...(fs.existsSync(rom) ? { rom } : {}) });
        const runs = label('runs');
        const start = label('start');
        // reset po 50 snímcích; počkat na dva resety vyvolané programem (první je z launch)
        const deadline = Date.now() + 20000;
        while (resets.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        assert.ok(resets.length >= 3, `resetů ${resets.length}`);
        await new Promise((r) => setTimeout(r, 400));   // nahrání po resetu (odpočet snímků)
        await server.request('pause');
        const s = await server.request('state');
        const mem = Buffer.from((await server.request('readMemory', { addr: start, length: runs - start + 1 })).data, 'base64');
        const code = Buffer.from(fs.readFileSync(program)).includes(mem.subarray(0, 4));
        assert.ok(code, 'kód programu je zpátky v paměti');
        assert.equal(mem[runs - start], 1, 'program po novém nahrání začal znovu od začátku');
        assert.ok(s.pc >= start && s.pc <= runs, `PC $${s.pc.toString(16)} v programu, ne v ROM`);
    } finally {
        server.close();
    }
});
