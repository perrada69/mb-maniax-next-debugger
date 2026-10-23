// Ladicí informace ze sjasmplus (--sld): řádky zdrojáku ↔ adresy (s 8K stránkou), návěští.
//
// Formát (SLD verze 1), jeden záznam na řádek:
//   soubor|řádek|definiční soubor|definiční řádek|stránka|hodnota|typ|data
// typ T = instrukce na řádku (hodnota = adresa), F/L = návěští (data u L: ",modul,jméno,lokální,…"),
// Z = popis zařízení. Stránka -1 = bez zařízení (adresa platí v každém mapování).
// K = komentář s klíčovým slovem ze SLDOPT COMMENT (data = celý komentář včetně ";" / "//",
// hodnota = adresa na začátku řádku, u samostatného komentáře adresa následujícího kódu).
// sjasmplus hledá slovo kdekoli v komentáři, rozlišuje velikost písmen a nehlídá hranice slov
// („WPMEMX“ projde); blokové komentáře /* */ nezapisuje. U makra je soubor|řádek místo volání.

import * as fs from 'fs';
import * as path from 'path';

export interface Location {
    file: string;   // absolutní cesta
    line: number;   // od 1
}

export interface Address {
    addr: number;
    page: number;   // 8K stránka, -1 = libovolná
}

export interface Label extends Address {
    name: string;
}

/** Klíčové slovo v komentáři (syntaxe podle DeZog). */
export type KeywordKind = 'WPMEM' | 'LOGPOINT' | 'ASSERTION';

export interface Keyword extends Location, Address {
    kind: KeywordKind;
    /** text za klíčovým slovem (oříznutý) */
    args: string;
}

/** WPMEM [adresa [, délka [, přístup [, podmínka]]]] – prázdné části = výchozí hodnoty. */
export interface WpmemArgs {
    addr?: string;
    size?: string;
    access?: string;
    condition?: string;
}

const KEYWORD_RE = /(?:^|[^A-Za-z0-9_])(WPMEM|LOGPOINT|ASSERTION)(?![A-Za-z0-9_])(.*)$/;

/** Části oddělené čárkou mimo závorky a uvozovky. */
function splitTop(s: string, sep: string, max = Infinity): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < s.length; ++i) {
        const c = s[i];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
            // apostrof za písmenem je stínový registr (AF'), ne uvozovka
            if (c === '"' || !/[A-Za-z]/.test(s[i - 1] ?? '')) quote = c;
        } else if (c === '(' || c === '[') ++depth;
        else if (c === ')' || c === ']') --depth;
        else if (c === sep && depth === 0 && out.length < max - 1) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out.map((x) => x.trim());
}

export function parseWpmem(args: string): WpmemArgs {
    const [addr, size, access, condition] = splitTop(args, ',', 4);
    return {
        ...(addr ? { addr } : {}),
        ...(size ? { size } : {}),
        ...(access ? { access } : {}),
        ...(condition ? { condition } : {}),
    };
}

/** LOGPOINT [SKUPINA] text – skupina v hranatých závorkách hned za slovem. */
export function parseLogpoint(args: string): { group?: string; text: string } {
    const m = /^\[([^\]]*)\]\s*(.*)$/.exec(args);
    return m ? { group: m[1].trim() || undefined, text: m[2] } : { text: args };
}

function key(file: string): string {
    return path.normalize(file).toLowerCase();
}

export class SldInfo {
    /** soubor → řádek → adresy instrukcí na řádku */
    private lines = new Map<string, Map<number, Address[]>>();
    /** adresa → místa ve zdrojáku (víc stránek může mít stejnou adresu) */
    private byAddr = new Map<number, Array<Location & { page: number }>>();
    /** fyzická 8K stránka × 0x2000 + posun ve stránce → místo ve zdrojáku */
    private byPhys = new Map<number, Location>();
    /** 8K stránka → řádky zdrojáku s instrukcí ("soubor:řádek"), pro mapu paměti v panelu Next */
    private pageLines = new Map<number, Set<string>>();
    readonly labels: Label[] = [];
    /** klíčová slova WPMEM / LOGPOINT / ASSERTION z komentářů (pořadí jako v SLD) */
    readonly keywords: Keyword[] = [];
    private labelsByName = new Map<string, Label>();
    private sortedLabels: Label[] = [];

    static load(sldPath: string, sourceRoot?: string): SldInfo {
        const info = new SldInfo();
        const root = sourceRoot || path.dirname(sldPath);
        const text = fs.readFileSync(sldPath, 'utf8');
        for (const raw of text.split(/\r?\n/)) {
            if (!raw || raw.startsWith('|')) continue;
            const f = raw.split('|');
            if (f.length < 7) continue;
            const file = path.resolve(root, f[0]);
            const line = parseInt(f[1], 10);
            const page = parseInt(f[4], 10);
            const value = parseInt(f[5], 10);
            const type = f[6];
            if (!Number.isFinite(line) || !Number.isFinite(value)) continue;
            const pg = Number.isFinite(page) ? page : -1;
            if (type === 'T') info.addLine(file, line, value & 0xffff, pg);
            else if (type === 'F') info.addLabel(f[7] || '', value & 0xffff, pg);
            else if (type === 'K') info.addKeyword(file, line, value, pg, f.slice(7).join('|'));
        }
        info.sortedLabels = [...info.labels].sort((a, b) => a.addr - b.addr);
        return info;
    }

    private addLine(file: string, line: number, addr: number, page: number): void {
        let m = this.lines.get(key(file));
        if (!m) this.lines.set(key(file), (m = new Map()));
        let a = m.get(line);
        if (!a) m.set(line, (a = []));
        a.push({ addr, page });
        let l = this.byAddr.get(addr);
        if (!l) this.byAddr.set(addr, (l = []));
        l.push({ file, line, page });
        if (page >= 0) {
            const k = page * 0x2000 + (addr & 0x1fff);
            if (!this.byPhys.has(k)) this.byPhys.set(k, { file, line });
            let pl = this.pageLines.get(page);
            if (!pl) this.pageLines.set(page, (pl = new Set()));
            pl.add(`${key(file)}:${line}`);
        }
    }

    private addKeyword(file: string, line: number, value: number, page: number, comment: string): void {
        if (value < 0) return;   // mimo kód (např. za koncem bez ORG)
        const m = KEYWORD_RE.exec(comment);
        if (!m) return;
        this.keywords.push({ kind: m[1] as KeywordKind, file, line, addr: value & 0xffff, page, args: m[2].trim() });
    }

    private addLabel(name: string, addr: number, page: number): void {
        if (!name || this.labelsByName.has(name)) return;
        const l = { name, addr, page };
        this.labels.push(l);
        this.labelsByName.set(name, l);
    }

    hasFile(file: string): boolean {
        return this.lines.has(key(file));
    }

    /**
     * Adresy pro breakpoint na řádku `line`; když na něm není instrukce, posune se na nejbližší
     * další řádek s instrukcí (nejvýš o 20 – komentáře, návěští na samostatném řádku).
     */
    addressesFor(file: string, line: number): { line: number; addrs: Address[] } | undefined {
        const m = this.lines.get(key(file));
        if (!m) return undefined;
        for (let l = line; l < line + 20; ++l) {
            const a = m.get(l);
            if (a && a.length) return { line: l, addrs: a };
        }
        return undefined;
    }

    /** Začátky všech instrukcí ze zdrojáku (adresa a 8K stránka, −1 = bez DEVICE). */
    codeAddresses(): Address[] {
        const out: Address[] = [];
        for (const [addr, l] of this.byAddr) for (const page of new Set(l.map((x) => x.page))) out.push({ addr, page });
        return out;
    }

    /** Počet řádků zdrojáku s instrukcí v každé 8K stránce (klíč = číslo stránky; bez DEVICE nic). */
    codePageCounts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [page, lines] of [...this.pageLines].sort((a, b) => a[0] - b[0])) out[String(page)] = lines.size;
        return out;
    }

    /** Místo ve zdrojáku pro adresu; `pageOf` dá 8K stránku namapovanou na adrese. */
    locate(addr: number, pageOf?: (addr: number) => number): Location | undefined {
        const l = this.byAddr.get(addr & 0xffff);
        if (!l || !l.length) return undefined;
        if (l.length === 1 || !pageOf) return l[0];
        const p = pageOf(addr);
        return l.find((x) => x.page === p) || l.find((x) => x.page < 0) || l[0];
    }

    /**
     * Místo ve zdrojáku pro fyzickou 8K stránku (0–255, číslo jako v MMU) a posun ve stránce
     * (0–8191) – adresa začátku instrukce (jako PC v profileru). Data a adresy uprostřed instrukce
     * v SLD řádek nemají (délka instrukce v SLD není) → undefined; stejně tak řádky bez
     * zařízení (stránka -1 v SLD), ty fyzickou stránku nemají.
     */
    locatePage(page: number, offset: number): Location | undefined {
        return this.byPhys.get(page * 0x2000 + (offset & 0x1fff));
    }

    label(name: string): Label | undefined {
        return this.labelsByName.get(name);
    }

    /** Nejbližší návěští na adrese nebo před ní ("main_loop+3"). */
    nameFor(addr: number): string | undefined {
        let lo = 0;
        let hi = this.sortedLabels.length - 1;
        let best: Label | undefined;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.sortedLabels[mid].addr <= addr) {
                best = this.sortedLabels[mid];
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (!best || addr - best.addr > 0x400) return undefined;
        return addr === best.addr ? best.name : `${best.name}+${addr - best.addr}`;
    }

    /** Návěští pro server (formát "JMÉNO = $ADRESA", MapFormat::Simple v JNEXT). */
    symbolMap(): string {
        return this.labels.map((l) => `${l.name} = $${l.addr.toString(16).toUpperCase().padStart(4, '0')}`).join('\n') + '\n';
    }
}
