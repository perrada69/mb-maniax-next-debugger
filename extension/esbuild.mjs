// Sestavení rozšíření do dist/ (esbuild): extension.js pro VS Code, adapter.js pro testy.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
    entryPoints: { extension: 'src/extension.ts', adapter: 'src/adapter.ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outdir: 'dist',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
} else {
    await esbuild.build(options);
}
