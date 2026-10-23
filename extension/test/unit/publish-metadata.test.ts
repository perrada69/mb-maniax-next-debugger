// Metadata pro vydání na Marketplace (docs/publishing.md): ikona, odkazy na repozitář,
// záznam verze v CHANGELOG.md, licence.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));

test('package.json: vydavatel, licence, odkazy na repozitář na GitHubu', () => {
    assert.match(pkg.publisher, /^[A-Za-z0-9][A-Za-z0-9-]*$/, 'ID vydavatele bez mezer');
    assert.equal(pkg.license, 'GPL-3.0-or-later');
    assert.ok(fs.existsSync(path.join(EXT, 'LICENSE')));
    for (const url of [pkg.repository.url, pkg.homepage, pkg.bugs.url]) assert.match(url, /^https:\/\/github\.com\/perrada69\/mb-maniax-next-debugger/);
});

test('ikona: PNG aspoň 128 × 128 a v balíčku (není ve .vscodeignore)', () => {
    const png = fs.readFileSync(path.join(EXT, pkg.icon));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    assert.ok(w >= 128 && h >= 128, `${w}×${h}`);
    const ignore = fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(!ignore.includes(pkg.icon) && !ignore.some((l) => l === 'images/**'), 'ikona se nesmí vyloučit');
});

test('CHANGELOG.md má záznam pro aktuální verzi', () => {
    const log = fs.readFileSync(path.join(EXT, 'CHANGELOG.md'), 'utf8');
    assert.match(log, new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}\\b`, 'm'));
});
