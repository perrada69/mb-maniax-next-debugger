// NextZXOS se nikdy nepřibaluje (licence distribuce, docs/protocol.md): v rozšíření ani v repozitáři
// není obraz karty, ROM, firmware ani zip distribuce. Výchozí URL, otisk a velikost v nastavení
// (package.json) jsou tytéž, které použije kód, když nastavení chybí.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.join(__dirname, '..');
const REPO = path.join(EXT, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(EXT, 'src', 'nextzxos.ts'), 'utf8');

test('výchozí distribuce: package.json a nextzxos.ts se shodují', () => {
    const props = pkg.contributes.configuration.properties;
    const url = props['mbxNext.nextzxos.url'].default;
    const sha = props['mbxNext.nextzxos.sha256'].default;
    const size = props['mbxNext.nextzxos.size'].default;
    assert.match(url, /^https:\/\/www\.specnext\.com\/distro\//);
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.ok(src.includes(`'${url}'`), 'URL v nextzxos.ts');
    assert.ok(src.includes(`'${sha}'`), 'SHA-256 v nextzxos.ts');
    assert.ok(src.includes(`, ${size})`), 'velikost v nextzxos.ts');
});

test('žádná část distribuce v repozitáři ani v balíčku rozšíření', () => {
    // media/48.rom (ROM 48K Spectra, Amstrad její šíření s emulátory povoluje) do distribuce
    // NextZXOS nepatří; ROM NextZXOS jsou en*.rom (enNextZX.rom, enNxtmmc.rom, …).
    const banned = /\.(img|mmc|hdf)$|^en.*\.rom$|^tbblue\.(fw|tbu)$|^sn-.*\.zip$/i;
    const skip = new Set(['node_modules', '.git', 'build', 'release', 'out-test']);
    const found: string[] = [];
    (function walk(dir: string) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(f.name)) continue;
            const p = path.join(dir, f.name);
            if (f.isDirectory()) walk(p);
            else if (banned.test(f.name)) found.push(path.relative(REPO, p));
        }
    })(REPO);
    assert.deepEqual(found, []);
});
