// Předpřeložené programy v test/fixtures odpovídají zdrojákům (keywords.asm, examples/hello,
// examples/features): přeloží je znovu sjasmplusem do dočasné složky a porovná. Bez sjasmplusu
// se přeskočí. Oprava: node test/fixtures/build.mjs
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FIXTURES } from './dap-client';

test('test/fixtures/*.nex a *.sld jsou přeložené z aktuálních zdrojáků', { timeout: 30000 }, (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-fixtures-check-'));
    try {
        const r = spawnSync(process.execPath, [path.join(FIXTURES, 'build.mjs'), out], { encoding: 'utf8' });
        if (r.status !== 0 && /sjasmplus nenalezen/.test(r.stderr)) {
            t.skip('sjasmplus není k dispozici (proměnná SJASMPLUS)');
            return;
        }
        assert.equal(r.status, 0, r.stderr);
        const stale: string[] = [];
        for (const name of ['keywords', 'hello', 'features'])
            for (const ext of ['.nex', '.sld']) {
                const f = name + ext;
                if (!fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(FIXTURES, f)))) stale.push(f);
            }
        assert.deepEqual(stale, [], 'zastaralé – spusť node test/fixtures/build.mjs');
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
