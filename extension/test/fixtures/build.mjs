// Předpřeložené programy pro integrační testy: test/fixtures/keywords.asm a příklady
// examples/hello, examples/features → <cíl>/<jméno>.nex + .sld (SLD s relativními cestami,
// testy je načítají se sourceRoot = složka se zdrojákem).
//
//   node test/fixtures/build.mjs [cílová složka]     (výchozí test/fixtures)
//
// sjasmplus: proměnná SJASMPLUS, jinak D:\Source\Assembler\aswcurr\bin\sjasmplus.exe, jinak PATH.
// Test integration/fixtures.test.ts tímto skriptem ověřuje, že commitnuté soubory odpovídají zdrojákům.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..', '..', '..');

export const PROGRAMS = [
    { name: 'keywords', dir: here, args: ['--zxnext=cspect'] },
    { name: 'hardreset', dir: here, args: [] },
    { name: 'writer', dir: here, args: [] },
    { name: 'uart', dir: here, args: [] },
    { name: 'mouse', dir: here, args: [] },
    { name: 'hello', dir: path.join(repo, 'examples', 'hello'), args: [] },
    { name: 'features', dir: path.join(repo, 'examples', 'features'), args: ['--zxnext=cspect'] },
];

export function sjasmplus() {
    const cands = [process.env.SJASMPLUS, 'D:\\Source\\Assembler\\aswcurr\\bin\\sjasmplus.exe'].filter(Boolean);
    for (const c of cands) if (fs.existsSync(c)) return c;
    const r = spawnSync('sjasmplus', ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? 'sjasmplus' : undefined;
}

export function build(out) {
    const exe = sjasmplus();
    if (!exe) throw new Error('sjasmplus nenalezen (proměnná SJASMPLUS)');
    fs.mkdirSync(out, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-fixtures-'));
    try {
        for (const p of PROGRAMS) {
            fs.copyFileSync(path.join(p.dir, p.name + '.asm'), path.join(tmp, p.name + '.asm'));
            const r = spawnSync(exe, [...p.args, `--sld=${p.name}.sld`, '--nologo', `${p.name}.asm`], { cwd: tmp, encoding: 'utf8' });
            if (r.status !== 0) throw new Error(`${p.name}.asm: ${r.stdout}${r.stderr}`);
            for (const ext of ['.nex', '.sld']) fs.copyFileSync(path.join(tmp, p.name + ext), path.join(out, p.name + ext));
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(here, 'build.mjs')) {
    const out = path.resolve(process.argv[2] || here);
    build(out);
    console.log('hotovo:', out);
}
