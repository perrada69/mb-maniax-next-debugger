// Sestavení testů (esbuild): test/**/*.test.ts → out-test/*.test.js, modul vscode nahrazuje
// test/stubs/vscode.js. Spuštění: npm test (node --test out-test).
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tests = [];
(function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.test.ts')) tests.push(p);
    }
})(root);

fs.rmSync(path.join(root, '..', 'out-test'), { recursive: true, force: true });
await esbuild.build({
    entryPoints: tests,
    entryNames: '[name]',   // plochá složka: ../l10n z out-test míří na extension/l10n
    outdir: path.join(root, '..', 'out-test'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: 'inline',
    alias: { vscode: path.join(root, 'stubs', 'vscode.js') },
    logLevel: 'warning',
});
// Samostatný adaptér ze src (integration/adapter-standalone.test.ts) – vždy čerstvý, nezávisle na dist/.
await esbuild.build({
    entryPoints: [path.join(root, '..', 'src', 'adapter.ts')],
    outfile: path.join(root, '..', 'out-test', 'adapter.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'warning',
});
console.log(`testů: ${tests.length}`);
