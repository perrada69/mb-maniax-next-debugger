// Překlady textů rozšíření, adaptéru a panelů (webview). Slovníky jsou v l10n/<oblast>.json:
// { "en": { "klíč": "text {0}" }, "cs": { … }, … } – každá oblast (soubor) má vlastní klíče
// s předponou podle oblasti, takže se soubory navzájem nepřepisují. Chybějící překlad → angličtina
// → klíč. Bez závislosti na vscode (běží i v samostatném adaptéru, dist/adapter.js).

import * as fs from 'fs';
import * as path from 'path';

/** Podporované jazyky (kódy jako vscode.env.language). První je výchozí. */
export const LANGUAGES = ['en', 'cs', 'sk', 'es', 'de', 'fr', 'it', 'pl', 'pt-br', 'ru', 'uk', 'ja', 'zh-cn'] as const;
export type Language = (typeof LANGUAGES)[number];

const dir = path.join(__dirname, '..', 'l10n');
let all: Record<string, Record<string, string>> | undefined;
let lang: Language = 'en';
let dict: Record<string, string> = {};

/** Všechny slovníky sloučené podle jazyka (načtou se jednou). */
function load(): Record<string, Record<string, string>> {
    if (all) return all;
    all = {};
    let files: string[] = [];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
        // bez složky l10n: klíče se vrací tak, jak jsou
    }
    for (const f of files) {
        let data: Record<string, Record<string, string>>;
        try {
            data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (e: any) {
            // poškozený slovník jedné oblasti nesmí shodit rozšíření: jeho klíče zůstanou nepřeložené
            console.error(`l10n/${f}: ${e?.message ?? e}`);
            continue;
        }
        for (const [l, texts] of Object.entries(data)) Object.assign((all[l] ??= {}), texts);
    }
    return all;
}

/** Kód jazyka nebo locale ("cs-CZ", "pt_BR", "zh-Hans") → podporovaný jazyk, jinak undefined. */
export function matchLanguage(code: string | undefined): Language | undefined {
    if (!code) return undefined;
    const c = code.toLowerCase().replace('_', '-').split('.')[0];
    if (c.startsWith('pt')) return 'pt-br';
    if (c.startsWith('zh')) return 'zh-cn';
    const base = c.split('-')[0];
    return (LANGUAGES as readonly string[]).includes(base) ? (base as Language) : undefined;
}

/** Jazyk systému (Windows, macOS, Linux). */
export function systemLanguage(): string | undefined {
    return process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * Vybere jazyk: `setting` (nastavení mbxNext.language, "auto" = automaticky), jinak jazyk editoru,
 * pokud není angličtina (bez jazykového balíčku VS Code zůstává anglicky, třeba pro slovenštinu),
 * jinak jazyk systému, jinak angličtina.
 */
export function setLanguage(setting?: string, editorLanguage?: string): Language {
    const chosen =
        (setting && setting !== 'auto' ? matchLanguage(setting) : undefined) ??
        (matchLanguage(editorLanguage) !== 'en' ? matchLanguage(editorLanguage) : undefined) ??
        matchLanguage(systemLanguage()) ??
        'en';
    const d = load();
    lang = chosen;
    dict = { ...(d.en ?? {}), ...(d[chosen] ?? {}) };
    return chosen;
}

export function language(): Language {
    return lang;
}

/** Text podle klíče; {0}, {1} … nahradí argumenty. */
export function t(key: string, ...args: unknown[]): string {
    const s = dict[key] ?? key;
    return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
}

/** Slovník vybraného jazyka (s anglickou zálohou) pro webview, jen klíče s danými předponami. */
export function dictionary(...prefixes: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(dict)) if (!prefixes.length || prefixes.some((p) => k.startsWith(p))) out[k] = v;
    return out;
}

/** Bezpečné vložení slovníku do <script> ve webview. */
export function dictionaryScript(nonce: string, ...prefixes: string[]): string {
    const json = JSON.stringify({ lang, texts: dictionary(...prefixes) }).replace(/</g, '\\u003c');
    return `<script nonce="${nonce}">window.L10N = ${json};</script>`;
}

setLanguage(process.env.MBX_NEXT_LANG);
