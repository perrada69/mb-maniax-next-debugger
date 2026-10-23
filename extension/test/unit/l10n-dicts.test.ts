// Slovníky překladů: l10n/<oblast>.json (všechny jazyky, stejné klíče a parametry {n}, předpona
// oblasti), klíče použité v kódu ↔ slovníky, slovníky pro webview, package.json %klíč% ↔ package.nls*.json.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES } from '../../src/i18n';

const EXT = path.join(__dirname, '..');
const L10N = path.join(EXT, 'l10n');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const areas = fs.readdirSync(L10N).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const dicts: Record<string, Record<string, Record<string, string>>> = {};
for (const a of areas) dicts[a] = JSON.parse(read(path.join(L10N, a + '.json')));
const params = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort().join(',');

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p, ext, out);
        else if (ext.test(f.name)) out.push(p);
    }
    return out;
}
/** Zdroje, které překládají: rozšíření (src) a webview (media). */
const sources = [...walk(path.join(EXT, 'src'), /\.ts$/), ...walk(path.join(EXT, 'media'), /\.js$/)];
/** Zdroják bez komentářů (hrubě: řádky komentářů a „ // …“ za kódem), ať se nepočítají klíče z poznámek. */
const stripComments = (s: string) =>
    s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
const code = new Map(sources.map((f) => [path.relative(EXT, f).replace(/\\/g, '/'), stripComments(read(f))]));
const AREA_RE = areas.join('|');

/** Klíče v kódu: řetězce '<oblast>.<…>' (ne jména souborů next.js, screen.css …). */
function usedKeys(): Map<string, string> {
    const used = new Map<string, string>();
    const re = new RegExp(`['"\`]((?:${AREA_RE})\\.[A-Za-z][A-Za-z0-9_.]*)['"\`](?!\\s*\\+)`, 'g');
    for (const [f, s] of code) for (const m of s.matchAll(re)) if (!/\.(js|css|json|ts|html)$/.test(m[1])) used.set(m[1], f);
    return used;
}
/** Předpony složených klíčů v kódu ('session.server' + jméno). */
function dynamicPrefixes(): string[] {
    const re = new RegExp(`['"\`]((?:${AREA_RE})\\.[A-Za-z0-9_.]*)['"\`]\\s*\\+`, 'g');
    const out: string[] = [];
    for (const s of code.values()) for (const m of s.matchAll(re)) out.push(m[1]);
    return out;
}

test('každý slovník má všech 13 jazyků a nic navíc', () => {
    assert.ok(areas.length >= 10, 'slovníků: ' + areas.length);
    for (const a of areas) assert.deepEqual(Object.keys(dicts[a]).sort(), [...LANGUAGES].sort(), `l10n/${a}.json`);
});

test('všechny jazyky mají stejné klíče jako angličtina, neprázdné texty a stejné parametry {n}', () => {
    const problems: string[] = [];
    for (const a of areas) {
        const en = dicts[a].en;
        for (const l of LANGUAGES) {
            const d = dicts[a][l] ?? {};
            for (const k of Object.keys(en)) {
                if (!(k in d)) problems.push(`${a}/${l}: chybí ${k}`);
                else if (typeof d[k] !== 'string' || !d[k].trim()) problems.push(`${a}/${l}: prázdné ${k}`);
                else if (params(d[k]) !== params(en[k])) problems.push(`${a}/${l}: ${k} má parametry ${params(d[k])} místo ${params(en[k])}`);
            }
            for (const k of Object.keys(d)) if (!(k in en)) problems.push(`${a}/${l}: navíc ${k}`);
        }
    }
    assert.deepEqual(problems, []);
});

test('klíče mají předponu své oblasti (soubory se navzájem nepřepisují)', () => {
    const bad: string[] = [];
    const seen = new Map<string, string>();
    for (const a of areas)
        for (const k of Object.keys(dicts[a].en)) {
            if (!k.startsWith(a + '.')) bad.push(`${a}: ${k}`);
            if (seen.has(k)) bad.push(`${k} v ${seen.get(k)} i ${a}`);
            seen.set(k, a);
        }
    assert.deepEqual(bad, []);
});

test('každý klíč použitý v kódu je ve slovníku', () => {
    const all = new Set(areas.flatMap((a) => Object.keys(dicts[a].en)));
    const missing = [...usedKeys()].filter(([k]) => !all.has(k)).map(([k, f]) => `${k} (${f})`);
    assert.deepEqual(missing, []);
});

test('každé t(\'…\') v kódu míří do existujícího slovníku (i oblast bez souboru l10n)', () => {
    const all = new Set(areas.flatMap((a) => Object.keys(dicts[a].en)));
    const missing = new Set<string>();
    for (const [f, s] of code)
        for (const m of s.matchAll(/\bt\(\s*'([a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9_.]*)'/g)) if (!all.has(m[1])) missing.add(`${m[1].split('.')[0]}.* (${f})`);
    assert.deepEqual([...missing], []);
});

test('každý klíč slovníku se v kódu používá', () => {
    const used = usedKeys();
    const dyn = dynamicPrefixes();
    const unused = areas.flatMap((a) => Object.keys(dicts[a].en)).filter((k) => !used.has(k) && !dyn.some((p) => k.startsWith(p)));
    assert.deepEqual(unused, []);
});

test('webview dostává slovníky všech oblastí, které jeho skripty používají', () => {
    // Panel Next: dictionaryScript(nonce, 'next.', 'sprites.', …) v src/nextview.ts; obrazovka v src/screen.ts.
    const prefixesIn = (f: string) => {
        const m = /dictionaryScript\(\s*nonce\s*,([^)]*)\)/.exec(code.get(f) ?? '');
        assert.ok(m, `${f}: volání dictionaryScript`);
        return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const check = (host: string, scripts: string[]) => {
        const prefixes = prefixesIn(host);
        const used = usedKeys();
        const missing = new Set<string>();
        for (const [k, f] of used) if (scripts.includes(f) && !prefixes.some((p) => k.startsWith(p))) missing.add(`${k.split('.')[0]}. (${f})`);
        assert.deepEqual([...missing], [], host);
    };
    const views = [...code.keys()].filter((f) => f.startsWith('media/views/'));
    check('src/nextview.ts', ['media/next.js', ...views]);
    check('src/screen.ts', ['media/screen.js']);
});

test('pohledy volají jen dotazy povolené v src/nextview.ts', () => {
    const host = code.get('src/nextview.ts')!;
    const bad: string[] = [];
    for (const [f, s] of code) {
        if (!f.startsWith('media/views/')) continue;
        for (const m of s.matchAll(/\.request\(\s*'([A-Za-z]+)'/g)) if (!host.includes(`'${m[1]}'`)) bad.push(`${m[1]} (${f})`);
    }
    assert.deepEqual(bad, []);
});

test('package.json: každý %klíč% přeložen ve všech package.nls*.json, žádný navíc', () => {
    const pkgText = read(path.join(EXT, 'package.json'));
    const used = new Set([...pkgText.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
    assert.ok(used.size > 10);
    const problems: string[] = [];
    let en: Record<string, string> = {};
    for (const l of LANGUAGES) {
        const file = l === 'en' ? 'package.nls.json' : `package.nls.${l}.json`;
        const d: Record<string, string> = JSON.parse(read(path.join(EXT, file)));
        if (l === 'en') en = d;
        for (const k of used) if (typeof d[k] !== 'string' || !d[k].trim()) problems.push(`${file}: chybí ${k}`);
        for (const k of Object.keys(d)) if (!used.has(k)) problems.push(`${file}: nepoužitý ${k}`);
        for (const k of Object.keys(d)) if (en[k] !== undefined && params(d[k]) !== params(en[k])) problems.push(`${file}: parametry ${k}`);
    }
    assert.deepEqual(problems, []);
});

test('package.json: nastavení mbxNext.language nabízí právě jazyky z i18n.ts', () => {
    const pkg = JSON.parse(read(path.join(EXT, 'package.json')));
    const lang = pkg.contributes.configuration.properties['mbxNext.language'];
    assert.deepEqual(lang.enum, ['auto', ...LANGUAGES]);
    assert.equal(lang.enumItemLabels.length, lang.enum.length);
    assert.equal(lang.enumDescriptions.length, lang.enum.length);
});

test('package.json: žádný český text mimo překlady (popisky jdou přes %klíč%)', () => {
    const pkg = JSON.parse(read(path.join(EXT, 'package.json')));
    const czech: string[] = [];
    (function visit(v: any, p: string) {
        if (typeof v === 'string') {
            if (!/^%.+%$/.test(v) && /[ěščřžůňťď]/i.test(v) && !/enumItemLabels|enumDescriptions/.test(p)) czech.push(`${p} = ${v}`);
        } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, p + '.' + k);
    })(pkg, '');
    assert.deepEqual(czech, []);
});
