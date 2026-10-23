// Příkaz Otevřít uživatelskou příručku (src/manual.ts): výběr PDF podle jazyka, záloha na druhý
// jazyk, hláška, když příručka v instalaci chybí; příkaz je v package.json.
import { vs } from './ext-vscode-setup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLanguage, t } from '../../src/i18n';
import { manualFile, manualLanguage, openManual } from '../../src/manual';

function installWith(...langs: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-manual-'));
    fs.mkdirSync(path.join(dir, 'manual'));
    for (const l of langs) fs.writeFileSync(path.join(dir, 'manual', `MB-Maniax-Next-Debugger-manual-${l}.pdf`), '%PDF-1.7');
    return dir;
}

test('jazyk příručky: čeština i pro slovenštinu, ostatní anglicky', () => {
    assert.equal(manualLanguage('cs'), 'cs');
    assert.equal(manualLanguage('sk'), 'cs');
    for (const l of ['en', 'de', 'ja', 'pt-br']) assert.equal(manualLanguage(l), 'en');
});

test('manualFile: PDF v jazyce, jinak druhý jazyk, jinak nic', () => {
    const both = installWith('cs', 'en');
    assert.match(manualFile(both, 'sk')!, /manual-cs\.pdf$/);
    assert.match(manualFile(both, 'de')!, /manual-en\.pdf$/);
    assert.match(manualFile(installWith('en'), 'cs')!, /manual-en\.pdf$/);
    assert.equal(manualFile(installWith(), 'cs'), undefined);
});

test('openManual otevře PDF ve výchozím programu, bez příručky ukáže hlášku', async () => {
    const opened: string[] = [];
    const warned: string[] = [];
    vs.env.openExternal = async (u: any) => (opened.push(u.fsPath), true);
    vs.window.showWarningMessage = async (m: string) => void warned.push(m);
    setLanguage('cs');
    await openManual(installWith('cs', 'en'));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /manual-cs\.pdf$/);
    await openManual(installWith());
    assert.deepEqual(warned, [t('extension.manualMissing')]);
});

test('package.json: příkaz mbxNext.openManual s přeloženým názvem', () => {
    const ext = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
    const cmd = pkg.contributes.commands.find((c: any) => c.command === 'mbxNext.openManual');
    assert.ok(cmd);
    assert.equal(cmd.title, '%command.openManual%');
});
