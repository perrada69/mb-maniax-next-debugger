// Profiler: server sčítá T-stavy podle fyzického místa instrukce (8K stránka + posun); rozšíření
// data převede na řádky zdrojáku (SLD) a funkce (návěští) a ukáže je v editorech: šedý text za
// koncem řádku, pozadí řádku podle podílu (teplotní škála) a značky v přehledu u posuvníku.
//
// Čistá část (parseProfile, aggregateProfile, formátování) nepotřebuje vscode – testuje se v Node.

import * as path from 'path';
import * as vscode from 'vscode';
import { language, t } from './i18n';
import { NextDebugSession, SessionListener } from './session';
import { Address, Label, Location } from './sld';

// ------------------------------------------------------------------ čistá část (bez vscode)

/** Jeden záznam profileru: instrukce na fyzickém místě `page`:`offset` (logicky `pc`) a její T-stavy. */
export interface ProfileEntry {
    page: number;   // fyzická 8K stránka 0–255
    offset: number; // posun ve stránce 0–8191
    pc: number;     // logická adresa (pro SLD bez stránek)
    t: number;      // T-stavy celkem
}

export interface ProfileData {
    active?: boolean;   // běží profiler na serveru (chybí = neznámo)
    total: number;  // všechny T-stavy za dobu profilování (i mimo zdroják)
    entries: ProfileEntry[];
}

/**
 * Odpověď serveru `profilerData` → ProfileData. Jediné místo, které zná formát přenosu:
 * - `{active, total, count, entries: [{page, offset, pc, t}, …]}` (neběžící profiler: active false, prázdná data),
 * - kompaktně `entries: [page, offset, pc, t, page, offset, pc, t, …]` (plochá čísla po čtveřicích).
 * Chybějící `total` = součet záznamů.
 */
export function parseProfile(raw: any): ProfileData {
    const entries: ProfileEntry[] = [];
    const src = raw?.entries;
    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
    if (Array.isArray(src)) {
        if (src.length && typeof src[0] === 'number') {
            for (let i = 0; i + 3 < src.length; i += 4)
                entries.push({ page: num(src[i]) & 0xff, offset: num(src[i + 1]) & 0x1fff, pc: num(src[i + 2]) & 0xffff, t: num(src[i + 3]) });
        } else {
            for (const e of src) {
                if (!e || typeof e !== 'object') continue;
                entries.push({ page: num(e.page) & 0xff, offset: num(e.offset) & 0x1fff, pc: num(e.pc) & 0xffff, t: num(e.t) });
            }
        }
    }
    const sum = entries.reduce((s, e) => s + e.t, 0);
    const total = num(raw?.total);
    const out: ProfileData = { total: total > 0 ? Math.max(total, sum) : sum, entries: entries.filter((e) => e.t > 0) };
    if (typeof raw?.active === 'boolean') out.active = raw.active;
    return out;
}

/** Co profiler potřebuje z ladicích informací (SldInfo; `locatePage` přidává adaptér, je nepovinná). */
export interface ProfileSld {
    readonly labels: readonly Label[];
    label(name: string): Label | undefined;
    locate(addr: number, pageOf?: (addr: number) => number): Location | undefined;
    locatePage?(page: number, offset: number): Location | undefined;
    addressesFor?(file: string, line: number): { line: number; addrs: Address[] } | undefined;
}

export interface FileCost {
    file: string;   // cesta ze SLD
    t: number;
    lines: Map<number, number>; // řádek → T-stavy
}

export interface FunctionCost {
    name: string;   // '' = bez návěští
    t: number;
    location?: Location;   // návěští ve zdrojáku, jinak nejdražší řádek funkce
}

export interface ProfileSummary {
    total: number;
    files: Map<string, FileCost>;   // klíč = fileKey(cesta)
    functions: FunctionCost[];      // seřazené od nejdražší
    maxLine: number;                // T-stavy nejdražšího řádku (pro škálu)
    unmapped: number;               // T-stavy mimo zdroják (ROM, kód bez SLD)
}

/** Klíč souboru pro porovnání cest (Windows: bez ohledu na velikost písmen). */
export function fileKey(file: string): string {
    return path.normalize(file).toLowerCase();
}

/**
 * Místo ve zdrojáku pro záznam: podle fyzické stránky (locatePage), jinak podle logické adresy –
 * ale jen řádek bez stránky (SLD bez zařízení) nebo ze stejné stránky, ať se kód z jiné banky na
 * stejné adrese nepřipíše cizímu řádku.
 */
function locateEntry(sld: ProfileSld, e: ProfileEntry): Location | undefined {
    const phys = sld.locatePage?.(e.page, e.offset);
    if (phys) return phys;
    const loc = sld.locate(e.pc, () => e.page);
    if (!loc || !sld.addressesFor) return loc;
    const a = sld.addressesFor(loc.file, loc.line);
    const ok = a?.line === loc.line && a.addrs.some((x) => x.addr === e.pc && (x.page < 0 || x.page === e.page));
    return ok ? loc : undefined;
}

/**
 * Hledání funkce (nejbližšího globálního návěští před adresou) se stránkou: návěští ze stejné
 * 8K stránky (nebo bez stránky) na adrese ≤ pc, nejvýš 8 KiB zpět.
 */
function functionFinder(sld: ProfileSld): (e: ProfileEntry) => Label | undefined {
    // jen globální návěští: lokální "fn.loop" → "fn", pokud "fn" existuje (moduly "mod.fn" zůstanou)
    const globalName = (name: string): string => {
        const parts = name.split('.');
        for (let i = 1; i < parts.length; ++i) {
            const prefix = parts.slice(0, i).join('.');
            if (sld.label(prefix)) return prefix;
        }
        return name;
    };
    const globals = sld.labels.filter((l) => globalName(l.name) === l.name).sort((a, b) => a.addr - b.addr);
    const cache = new Map<number, Label | undefined>();
    return (e) => {
        const k = e.page * 0x10000 + e.pc;
        if (cache.has(k)) return cache.get(k);
        let lo = 0;
        let hi = globals.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (globals[mid].addr <= e.pc) {
                idx = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        let found: Label | undefined;
        for (let i = idx; i >= 0 && e.pc - globals[i].addr < 0x2000; --i) {
            const l = globals[i];
            if (l.page < 0 || l.page === e.page) {
                found = l;
                break;
            }
        }
        cache.set(k, found);
        return found;
    };
}

/** Data profileru → T-stavy po řádcích a souborech, funkce seřazené od nejdražší. */
export function aggregateProfile(data: ProfileData, sld: ProfileSld | undefined): ProfileSummary {
    const files = new Map<string, FileCost>();
    const funcs = new Map<string, { t: number; label?: Label; hot?: Location; hotT: number }>();
    const findFunction = sld ? functionFinder(sld) : () => undefined;
    let unmapped = 0;
    let maxLine = 0;
    // T-stavy po řádcích funkce (pro nejdražší řádek bez návěští)
    const funcLines = new Map<string, Map<string, { loc: Location; t: number }>>();
    for (const e of data.entries) {
        const loc = sld ? locateEntry(sld, e) : undefined;
        if (loc) {
            const k = fileKey(loc.file);
            let f = files.get(k);
            if (!f) files.set(k, (f = { file: loc.file, t: 0, lines: new Map() }));
            f.t += e.t;
            const lt = (f.lines.get(loc.line) ?? 0) + e.t;
            f.lines.set(loc.line, lt);
            if (lt > maxLine) maxLine = lt;
        } else unmapped += e.t;

        const label = findFunction(e);
        const name = label?.name ?? '';
        let fn = funcs.get(name);
        if (!fn) funcs.set(name, (fn = { t: 0, label, hotT: 0 }));
        fn.t += e.t;
        if (loc) {
            let fl = funcLines.get(name);
            if (!fl) funcLines.set(name, (fl = new Map()));
            const lk = fileKey(loc.file) + '|' + loc.line;
            const x = fl.get(lk) ?? { loc, t: 0 };
            x.t += e.t;
            fl.set(lk, x);
            if (x.t > fn.hotT) {
                fn.hotT = x.t;
                fn.hot = loc;
            }
        }
    }
    const functions: FunctionCost[] = [...funcs.entries()]
        .map(([name, f]) => ({
            name,
            t: f.t,
            location: (f.label && sld?.locate(f.label.addr, () => f.label!.page)) || f.hot,
        }))
        .sort((a, b) => b.t - a.t || a.name.localeCompare(b.name));
    return { total: data.total, files, functions, maxLine, unmapped };
}

/** Stupeň teplotní škály 1…levels podle podílu na nejdražším řádku (0 = bez obarvení). */
export function heatLevel(lineT: number, maxLine: number, levels: number): number {
    if (lineT <= 0 || maxLine <= 0) return 0;
    return Math.min(levels, Math.max(1, Math.ceil((lineT / maxLine) * levels)));
}

/** Podíl v procentech na jedno desetinné místo. */
export function percent(part: number, total: number, lang = 'en'): string {
    const p = total > 0 ? (part * 100) / total : 0;
    return p.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Počet T-stavů s oddělovači tisíců. */
export function tstates(v: number, lang = 'en'): string {
    return Math.round(v).toLocaleString(lang);
}

// ------------------------------------------------------------------ VS Code

const LEVELS = 8;

/** Barva stupně: žlutá (málo) → červená (nejvíc); průhlednost roste se stupněm. */
function heatColor(level: number, alpha: number): string {
    const hue = Math.round(55 - (55 * (level - 1)) / (LEVELS - 1));
    return `hsla(${hue}, 100%, 50%, ${alpha.toFixed(2)})`;
}

export class ProfilerController implements SessionListener, vscode.Disposable {
    private session?: NextDebugSession;
    private active = false;
    private live = false;
    private summary?: ProfileSummary;
    private fetching?: Promise<void>;
    private timer?: NodeJS.Timeout;
    private readonly levels: vscode.TextEditorDecorationType[];
    private readonly status: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.levels = Array.from({ length: LEVELS }, (_, i) =>
            vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: heatColor(i + 1, 0.06 + (0.3 * i) / (LEVELS - 1)),
                overviewRulerColor: heatColor(i + 1, 0.85),
                overviewRulerLane: vscode.OverviewRulerLane.Right,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            }),
        );
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.status.command = 'mbxNext.profilerShow';
        this.disposables.push(
            ...this.levels,
            this.status,
            vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
        );
        void this.setActive(false);
    }

    /** Příkazy profileru (registruje extension.ts). */
    register(): vscode.Disposable[] {
        return [
            vscode.commands.registerCommand('mbxNext.profilerStart', () => this.start()),
            vscode.commands.registerCommand('mbxNext.profilerStop', () => this.stop()),
            vscode.commands.registerCommand('mbxNext.profilerClear', () => this.clear()),
            vscode.commands.registerCommand('mbxNext.profilerShow', () => this.showResults()),
            vscode.commands.registerCommand('mbxNext.profilerLive', () => this.toggleLive()),
            this,
        ];
    }

    dispose(): void {
        this.stopTimer();
        for (const d of this.disposables) d.dispose();
    }

    // -------------------------------------------------------------- SessionListener

    attach(session: NextDebugSession): void {
        this.session = session;
        this.summary = undefined;
        this.decorate();
        void this.setActive(false);
    }

    detach(session: NextDebugSession): void {
        if (this.session !== session) return;
        this.session = undefined;
        this.stopTimer();
        // výsledky zůstanou v editoru i po skončení ladění (do Vynulovat / dalšího sezení)
        void this.setActive(false);
    }

    state(running: boolean): void {
        if (running) this.updateTimer();
        else {
            this.stopTimer();
            if (this.active) void this.refresh();
        }
    }

    // -------------------------------------------------------------- příkazy

    private requireSession(): NextDebugSession | undefined {
        if (!this.session) void vscode.window.showWarningMessage(t('profiler.notDebugging'));
        return this.session;
    }

    private async start(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        try {
            await s.serverRequest('profilerStart');
            await this.setActive(true);
            vscode.window.setStatusBarMessage(t('profiler.started'), 3000);
        } catch (e: any) {
            this.error(e);
        }
    }

    private async stop(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        // stop data na serveru zahodí – nejdřív je stáhnout (chyba stažení zastavení nebrání)
        await this.refresh();
        try {
            await s.serverRequest('profilerStop');
            await this.setActive(false);
        } catch (e: any) {
            this.error(e);
            return;
        }
        // Výsledky po zastavení nabídnout rovnou – jinak je uživatel v editoru snadno přehlédne.
        const total = this.summary?.total;
        if (!total) {
            vscode.window.setStatusBarMessage(t('profiler.stopped'), 4000);
            return;
        }
        const show = t('profiler.showResultsButton');
        const pick = await vscode.window.showInformationMessage(t('profiler.stoppedResults', tstates(total, language())), show);
        if (pick === show) await this.showResults();
    }

    private async clear(): Promise<void> {
        this.summary = undefined;
        this.decorate();
        this.updateStatus();
        if (this.session) {
            try {
                await this.session.serverRequest('profilerClear');
            } catch (e: any) {
                this.error(e);
                return;
            }
        }
        vscode.window.setStatusBarMessage(t('profiler.cleared'), 3000);
    }

    private toggleLive(): void {
        this.live = !this.live;
        this.updateTimer();
        vscode.window.setStatusBarMessage(t(this.live ? 'profiler.liveOn' : 'profiler.liveOff'), 3000);
    }

    /** Stáhne aktuální data (je-li sezení) a ukáže nejdražší funkce. */
    private async showResults(): Promise<void> {
        if (this.session) {
            try {
                await this.refresh(true);
            } catch (e: any) {
                this.error(e);
            }
        }
        const sum = this.summary;
        if (!sum || !sum.total) {
            void vscode.window.showInformationMessage(this.session ? t('profiler.noData') : t('profiler.notDebugging'));
            return;
        }
        const lang = language();
        type Item = vscode.QuickPickItem & { location?: Location };
        const items: Item[] = sum.functions.map((f) => ({
            label: f.name ? `$(symbol-function) ${f.name}` : `$(question) ${t('profiler.unknownFunction')}`,
            description: t('profiler.cost', tstates(f.t, lang), percent(f.t, sum.total, lang)),
            detail: f.location ? `${path.basename(f.location.file)}:${f.location.line}` : t('profiler.noSource'),
            location: f.location,
        }));
        if (sum.unmapped > 0)
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, {
                label: `$(info) ${t('profiler.unmapped')}`,
                description: t('profiler.cost', tstates(sum.unmapped, lang), percent(sum.unmapped, sum.total, lang)),
            });
        const pick = await vscode.window.showQuickPick(items, {
            title: t('profiler.pickTitle', tstates(sum.total, lang)),
            placeHolder: t('profiler.pickPlaceholder'),
            matchOnDetail: true,
        });
        if (!pick?.location) return;
        const doc = await vscode.workspace.openTextDocument(pick.location.file);
        const pos = new vscode.Position(pick.location.line - 1, 0);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    }

    // -------------------------------------------------------------- data a zobrazení

    /** Stáhne data ze serveru (souběžné žádosti se spojí); `throws` = chybu předat volajícímu. */
    private async refresh(throws = false): Promise<void> {
        const s = this.session;
        if (!s) return;
        if (!this.fetching) {
            this.fetching = (async () => {
                try {
                    const data = parseProfile(await s.serverRequest('profilerData'));
                    // neběžící profiler vrací prázdná data – poslední výsledky v editoru zůstanou
                    if (data.active === false && !data.entries.length) {
                        if (this.active) await this.setActive(false);
                        return;
                    }
                    if (data.active !== undefined && data.active !== this.active) await this.setActive(data.active);
                    this.summary = aggregateProfile(data, s.getSld());
                    this.decorate();
                    this.updateStatus();
                } finally {
                    this.fetching = undefined;
                }
            })();
        }
        try {
            await this.fetching;
        } catch (e) {
            if (throws) throw e;
        }
    }

    private async setActive(active: boolean): Promise<void> {
        this.active = active;
        await vscode.commands.executeCommand('setContext', 'mbxNext.profilerActive', active);
        this.updateStatus();
        this.updateTimer();
    }

    /** Stavový řádek: za běhu profileru průběžný součet, po zastavení součet posledního měření (do Vynulovat). */
    private updateStatus(): void {
        const total = this.summary?.total;
        if (!this.active && !total) {
            this.status.hide();
            return;
        }
        const label = total ? `${t('profiler.status')}: ${tstates(total, language())} T` : t('profiler.status');
        this.status.text = `${this.active ? '$(pulse)' : '$(graph)'} ${label}`;
        this.status.tooltip = t(this.active ? 'profiler.statusTooltip' : 'profiler.statusStoppedTooltip');
        this.status.show();
    }

    /** Živé obnovování za běhu (každou 1 s), jen když je zapnuté, profiler běží a stroj taky. */
    private updateTimer(): void {
        const want = this.live && this.active && !!this.session?.isRunning();
        if (want && !this.timer) this.timer = setInterval(() => void this.refresh(), 1000);
        else if (!want) this.stopTimer();
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Dekorace ve všech viditelných editorech podle posledních dat. */
    private decorate(): void {
        const sum = this.summary;
        const lang = language();
        for (const editor of vscode.window.visibleTextEditors) {
            const byLevel: vscode.DecorationOptions[][] = this.levels.map(() => []);
            const f = sum?.files.get(fileKey(editor.document.uri.fsPath));
            if (sum && f) {
                const doc = editor.document;
                for (const [line, lt] of f.lines) {
                    if (line < 1 || line > doc.lineCount) continue;
                    const level = heatLevel(lt, sum.maxLine, LEVELS);
                    if (!level) continue;
                    const range = doc.lineAt(line - 1).range;
                    const ts = tstates(lt, lang);
                    const pc = percent(lt, sum.total, lang);
                    const hover = new vscode.MarkdownString(t('profiler.lineHover', ts, pc));
                    byLevel[level - 1].push({
                        range,
                        hoverMessage: hover,
                        renderOptions: {
                            after: {
                                contentText: ' ' + t('profiler.cost', ts, pc),
                                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                                fontStyle: 'italic',
                            },
                        },
                    });
                }
            }
            this.levels.forEach((type, i) => editor.setDecorations(type, byLevel[i]));
        }
    }

    private error(e: any): void {
        void vscode.window.showErrorMessage(t('profiler.failed', e?.message || String(e)));
    }
}
