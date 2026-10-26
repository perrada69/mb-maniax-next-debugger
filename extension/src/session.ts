// Ladicí sezení (Debug Adapter Protocol) nad ladicím serverem.
//
// VS Code mluví DAP s touto třídou; ta překládá řádky zdrojáku na adresy (SLD ze sjasmplus)
// a posílá serveru příkazy (server.ts). Podmínky breakpointů, logpointy a počty průchodů
// vyhodnocuje přímo emulátor (jazyk výrazů JNEXT); návěští ze SLD v nich jdou psát přímo.

import {
    Breakpoint,
    BreakpointEvent,
    ContinuedEvent,
    InitializedEvent,
    InvalidatedEvent,
    LoggingDebugSession,
    MemoryEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from './i18n';
import { ServerConnection, ServerError, ServerEvent } from './server';
import { Address, Keyword, parseLogpoint, parseWpmem, SldInfo } from './sld';

/** Kdo chce vědět o průběhu sezení (panely ve VS Code): připojení, odpojení, běh a zastavení. */
export interface SessionListener {
    attach(session: NextDebugSession): void;
    detach(session: NextDebugSession): void;
    state(running: boolean): void;
}

/** Kam posílat obraz a zvuk (panel s obrazovkou ve VS Code); bez něj se jen ladí. */
export interface ScreenSink extends SessionListener {
    frame(width: number, height: number, rgba: Buffer): void;
    audio(samples: Buffer): void;
}

export interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
    program: string;
    sld?: string;
    sourceRoot?: string;
    stopOnEntry?: boolean;
    machine?: string;
    sdImage?: string;
    esxdosRoot?: string;
    rewind?: boolean;
    /** Instrukce BREAK z CSpectu (DD 01) zastaví jako breakpoint (výchozí true). */
    magicBreakpoint?: boolean;
    /** Komentáře WPMEM ze SLD jako watchpointy (výchozí true). */
    wpmem?: boolean;
    /** Komentáře LOGPOINT ze SLD jako logpointy (výchozí true). */
    logpoints?: boolean;
    /** Komentáře ASSERTION ze SLD: zastavit, když podmínka neplatí (výchozí true). */
    assertions?: boolean;
    /** "nextzxos": stroj nabootuje NextZXOS z karty a program spustí NextZXOS (docs/protocol.md). */
    boot?: string;
    /** Složka programu na kartě (výchozí /MBX/<jméno programu>). */
    cardFolder?: string;
    /** NextZXOS program spustí sám (výchozí true); jinak se otevře Browser ve složce programu. */
    autorun?: boolean;
    /** Po sezení zkopírovat soubory, které program na kartě vytvořil nebo změnil, zpět (výchozí false). */
    syncBack?: boolean;
}

const THREAD = 1;
/** Čísla watchpointů pro server začínají jinde než breakpointy (ať se v `ids` nepletou). */
const WATCH_BASE = 100000;
const REGS8 = new Set(['A', 'F', 'B', 'C', 'D', 'E', 'H', 'L', 'IXH', 'IXL', 'IYH', 'IYL', 'I', 'R']);
const REGS16 = new Set(['AF', 'BC', 'DE', 'HL', 'IX', 'IY', 'SP', 'PC', "AF'", "BC'", "DE'", "HL'"]);
/** Formáty v logpointu `${výraz:formát}` (DeZog); znak = značka v textu pro server. */
const LOG_FORMATS: Record<string, string> = { unsigned: 'u', hex: 'h', signed: 's', char: 'c', bits: 'b', flags: 'f', labels: 'l' };
// Značky v textu logpointu: server nahradí {výraz} číslem a značky nechá být, adaptér pak číslo
// zformátuje (\x01 formát velikost číslo \x02), vrátí složené závorky z textu (\x04 \x05)
// a k výpisu připojí místo ve zdrojáku (\x06 číslo \x07).
const MARK_RE = /\x01([a-z])([012])(-?\d+|\?)\x02/g;
const SOURCE_RE = /^\x06(\d+)\x07/;
const REF_REGS = 1;
const REF_FLAGS = 2;
const REF_ALT = 3;
const REF_MACHINE = 4;

const MAIN_REGS = ['AF', 'BC', 'DE', 'HL', 'IX', 'IY', 'SP', 'PC'];
const ALT_REGS = ["AF'", "BC'", "DE'", "HL'"];
const FLAGS: Array<[string, number]> = [['S', 7], ['Z', 6], ['H', 4], ['P/V', 2], ['N', 1], ['C', 0]];
const REG_NAMES = new Set([
    'A', 'F', 'B', 'C', 'D', 'E', 'H', 'L', 'AF', 'BC', 'DE', 'HL', 'IX', 'IY', 'SP', 'PC',
    'IXH', 'IXL', 'IYH', 'IYL', 'I', 'R', 'IM', 'IFF1', 'IFF2',
]);

/** Události stroje jako „výjimky“ v panelu Breakpoints (zaškrtávátka s podmínkou), v aktuálním jazyce. */
function eventFilters(): DebugProtocol.ExceptionBreakpointsFilter[] {
    return [
        { filter: 'interrupt', label: t('session.filterInterrupt'), description: t('session.filterInterruptDescription'), supportsCondition: true, conditionDescription: t('session.filterInterruptCondition') },
        { filter: 'nmi', label: 'NMI', description: t('session.filterNmiDescription'), supportsCondition: true },
        { filter: 'nextreg', label: t('session.filterNextreg'), supportsCondition: true, conditionDescription: t('session.filterNextregCondition') },
        { filter: 'port', label: t('session.filterPort'), supportsCondition: true, conditionDescription: t('session.filterPortCondition') },
        { filter: 'copper', label: 'Copper (MOVE)', supportsCondition: true },
        { filter: 'dma', label: t('session.filterDma'), supportsCondition: true },
        { filter: 'reset', label: t('session.filterReset') },
    ];
}

/**
 * Texty serveru pro uživatele: server posílá anglický `text` a k němu `key` + `args`
 * (docs/protocol.md). Klíč `fooBar` → překlad `session.serverFooBar` v l10n/session.json
 * (tabulka níže jen pro výjimky z tohoto pravidla); klíč bez překladu zůstane anglicky (`text`).
 */
const SERVER_TEXTS: Record<string, string> = {
    loadFailed: 'session.serverLoadFailed',
    rewindFailed: 'session.serverRewindFailed',
    conditionError: 'session.serverConditionError',
    esxdosWritable: 'session.serverEsxdosWritable',
};

/** Klíč překladu pro `key` serveru (bez kontroly, zda překlad existuje). */
export function serverTextKey(key: string): string {
    return SERVER_TEXTS[key] ?? 'session.server' + key.charAt(0).toUpperCase() + key.slice(1);
}

/** Text hlášky serveru v jazyce rozšíření; neznámý klíč nebo chybějící překlad → anglický `text`. */
export function serverText(e: Record<string, unknown>): string {
    const text = String(e.text ?? '');
    if (typeof e.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(e.key)) return text;
    const key = serverTextKey(e.key);
    const translated = t(key, ...(Array.isArray(e.args) ? e.args.map(String) : []));
    if (translated === key) return text;   // klíč ve slovníku není
    return translated + (text.endsWith('\n') ? '\n' : '');
}

export interface SourceBp {
    id: number;
    /** řádek, na který breakpoint dal uživatel (z něj se po novém překladu počítá znovu) */
    requested: number;
    /** řádek s instrukcí, kam breakpoint padl (requested, nebo o kus níž) */
    line: number;
    /** adresy instrukcí; prázdné = neověřený (na řádku ani pod ním není kód, nebo chybí SLD) */
    addrs: Address[];
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
}

/** Breakpoint serveru z komentáře ASSERTION nebo LOGPOINT (viz sld.ts). */
interface KeywordBp {
    kw: Keyword;
    condition?: string;
    logMessage?: string;
}

type Access = 'read' | 'write' | 'readWrite';

/** Watchpoint (datový breakpoint z VS Code nebo komentář WPMEM). */
interface Watch {
    id?: number;   // DAP id (jen od uživatele)
    kw?: Keyword;
    addr: number;
    length: number;
    access: Access;
    condition?: string;
    hitCondition?: string;
}

/**
 * Breakpointy ve zdrojácích po novém překladu: adresy znovu podle (nového) SLD z řádku, který
 * zadal uživatel. VS Code posouvá značky s textem a po uložení pošle nové řádky – ještě se starým
 * SLD; správné adresy dá až SLD z nového překladu. Upraví `bps` na místě a vrátí ty breakpointy,
 * kterým se změnil řádek nebo adresy.
 */
export function relocateBreakpoints(bps: Map<string, SourceBp[]>, sld: SldInfo | undefined): SourceBp[] {
    const changed: SourceBp[] = [];
    for (const [file, list] of bps) {
        for (const bp of list) {
            const found = sld?.addressesFor(file, bp.requested);
            const line = found?.line ?? bp.requested;
            const addrs = found ? [...found.addrs] : [];
            const same =
                line === bp.line &&
                addrs.length === bp.addrs.length &&
                addrs.every((a, i) => a.addr === bp.addrs[i].addr && a.page === bp.addrs[i].page);
            bp.line = line;
            bp.addrs = addrs;
            if (!same) changed.push(bp);
        }
    }
    return changed;
}

function hex(v: number, digits: number): string {
    return '$' + v.toString(16).toUpperCase().padStart(digits, '0');
}

function fmt(v: number, bits: 8 | 16): string {
    return `${hex(v, bits / 4)} (${v})`;
}

/** Číslo z textu: $8000, 0x8000, #8000, 8000h, %1010, desítkově. */
function parseNumber(s: string): number | undefined {
    const t = s.trim();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(?:\$|0x|#)([0-9a-f]+)$/i))) return parseInt(m[1], 16);
    if ((m = t.match(/^([0-9a-f]+)h$/i))) return parseInt(m[1], 16);
    if ((m = t.match(/^%([01]+)$/))) return parseInt(m[1], 2);
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    return undefined;
}

/**
 * Výraz v syntaxi DeZog (WPMEM, LOGPOINT, ASSERTION) → jazyk JNEXT (bez návěští a registrů,
 * ty dodělá translate): b@(x) → mem[x], w@(x) → mem16[x], && || ! → and or not,
 * = → ==, čísla #FF, 0FFh, %1010 → $FF, 0b1010.
 */
function dezogToJnext(expr: string): string {
    let s = expr
        .replace(/&&/g, ' and ')
        .replace(/\|\|/g, ' or ')
        .replace(/!(?!=)/g, ' not ')
        .replace(/(^|[^=!<>])=(?!=)/g, '$1==')
        .replace(/#([0-9A-Fa-f]+)\b/g, '$$$1')
        .replace(/\b([0-9][0-9A-Fa-f]*)[hH]\b/g, '$$$1')
        // %1010 jen tam, kde se čeká číslo (za operandem je % zbytek po dělení)
        .replace(/%([01]+)\b/g, (tok, bits: string, offset: number, all: string) =>
            /[A-Za-z0-9_)\]']\s*$/.test(all.slice(0, offset)) ? tok : `0b${bits}`);
    // b@( … ) a w@( … ) s vnořenými závorkami
    for (;;) {
        const m = /\b([bwBW])@\s*\(/.exec(s);
        if (!m) break;
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < s.length && depth; ++i) {
            if (s[i] === '(') ++depth;
            else if (s[i] === ')') --depth;
        }
        if (depth) break;   // neuzavřená závorka – nechá chybu na překladači výrazů
        const inner = s.slice(m.index + m[0].length, i - 1);
        s = s.slice(0, m.index) + (m[1].toLowerCase() === 'b' ? 'mem[' : 'mem16[') + inner + ']' + s.slice(i);
    }
    return s.trim();
}

/** Šířka výsledku pro formát logpointu: 8bitový registr / b@ → 1, 16bitový / w@ → 2, jinak 0. */
function exprSize(expr: string): '0' | '1' | '2' {
    const e = expr.trim();
    if (/^b@/i.test(e) || REGS8.has(e.toUpperCase())) return '1';
    if (/^w@/i.test(e) || REGS16.has(e.toUpperCase())) return '2';
    return '0';
}

export class NextDebugSession extends LoggingDebugSession {
    private server?: ServerConnection;
    private sld?: SldInfo;
    private args?: LaunchArgs;
    private nextBpId = 1;
    private sourceBps = new Map<string, SourceBp[]>();
    private instructionBps: SourceBp[] = [];
    private serverToDap = new Map<number, number>();
    /** breakpointy z komentářů (ASSERTION, LOGPOINT) a jejich čísla u serveru */
    private keywordBps: KeywordBp[] = [];
    private serverToKeyword = new Map<number, KeywordBp>();
    /** watchpointy: datové breakpointy z VS Code a WPMEM; server dostává oba seznamy najednou */
    private userWatches: Watch[] = [];
    private keywordWatches: Watch[] = [];
    private serverToWatch = new Map<number, Watch>();
    /** varování ke klíčovým slovům, která už padla (ať se při každém setBreakpoints neopakují) */
    private keywordWarned = new Set<string>();
    /** cíle Jump to Cursor: id → adresa */
    private gotoTargets = new Map<number, number>();
    private swallowEntry = false;
    private onEntry?: () => void;
    private running = false;
    private regs: Record<string, number> = {};
    private mmu: number[] = [];
    private symbolFile?: string;
    private readonly watchers: SessionListener[];
    /** běžící „reload“ (customRequest) – druhý se odmítne, kroky čekají */
    private reloading?: Promise<unknown>;
    /** rozeslané příkazy běhu (krok, pokračovat…), na jejichž odpověď se čeká */
    private verbs = new Set<Promise<unknown>>();

    /** ROM 48K pro Next bez SD karty (media/48.rom; Amstrad její šíření s emulátory povoluje). */
    private readonly rom = path.join(__dirname, '..', 'media', '48.rom');

    constructor(
        private readonly serverPath: string = process.env.MBX_NEXT_SERVER || '',
        private readonly sink?: ScreenSink,
        listeners: SessionListener[] = [],
    ) {
        super();
        this.watchers = sink ? [sink, ...listeners] : listeners;
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    // ------------------------------------------------------------------ vstup z panelu obrazovky

    /** Klávesa, myš, joystick z panelu s obrazovkou. */
    input(cmd: string, args: Record<string, any>): void {
        this.server?.send(cmd, args);
    }

    async togglePause(): Promise<void> {
        if (!this.server) return;
        await this.server.request(this.running ? 'pause' : 'continue').catch(() => undefined);
    }

    /** Běží emulace (true), nebo stojí (pauza, breakpoint, krok)? */
    isRunning(): boolean {
        return this.running;
    }

    /** Dotaz na server pro panely (sprity, palety, paměť…); bez spuštěného serveru odmítne. */
    serverRequest(cmd: string, args: Record<string, any> = {}): Promise<any> {
        if (!this.server) return Promise.reject(new ServerError(t('session.notDebugging')));
        return this.server.request(cmd, args);
    }

    /** Ladicí informace ze SLD (převod adres na řádky zdrojáku, např. v profileru); bez SLD undefined. */
    getSld(): SldInfo | undefined {
        return this.sld;
    }

    /** Číslo emulovaného snímku (rychlost emulace v panelu; obraz chodí jen při změně). */
    async frameNumber(): Promise<number | undefined> {
        const r = await this.server?.request('state').catch(() => undefined);
        return r?.frame;
    }

    // ------------------------------------------------------------------ DAP: start a konec

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsLogPoints: true,
            supportsEvaluateForHovers: true,
            supportsStepBack: true,
            supportsDisassembleRequest: true,
            supportsInstructionBreakpoints: true,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsSetVariable: true,
            supportsRestartRequest: true,
            supportsTerminateRequest: true,
            supportsDataBreakpoints: true,
            supportsDataBreakpointBytes: true,
            supportsExceptionFilterOptions: true,
            supportsGotoTargetsRequest: true,
            exceptionBreakpointFilters: eventFilters(),
            supportsSteppingGranularity: false,
        };
        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
        this.args = args;
        try {
            if (!this.serverPath || !fs.existsSync(this.serverPath))
                throw new Error(t('session.serverNotFound', this.serverPath || t('session.serverPathNotSet')));
            if (!args.program || !fs.existsSync(args.program)) throw new Error(t('session.programNotFound', args.program));
            if (args.sld) {
                try {
                    this.sld = SldInfo.load(args.sld, args.sourceRoot);
                } catch (e: any) {
                    this.warn(t('session.sldLoadFailed', args.sld, e.message));
                }
            } else {
                this.warn(t('session.sldMissing'));
            }
            await this.startServer();
            await this.startProgram();
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        } catch (e: any) {
            this.sendErrorResponse(response, 1, e.message);
            this.sendEvent(new TerminatedEvent());
        }
    }

    private startServer(): Promise<void> {
        const server = new ServerConnection(this.serverPath, path.dirname(this.args!.program));
        this.server = server;
        server.on('event', (e: ServerEvent) => this.onServerEvent(e));
        server.on('stderr', (t: string) => this.sendEvent(new OutputEvent(t, 'stderr')));
        server.on('frame', (w: number, h: number, rgba: Buffer) => this.sink?.frame(w, h, rgba));
        server.on('audio', (s: Buffer) => this.sink?.audio(s));
        server.on('exit', () => this.sendEvent(new TerminatedEvent()));
        for (const l of this.watchers) l.attach(this);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(t('session.serverNoResponse'))), 10000);
            const ready = (e: ServerEvent) => {
                if (e.event !== 'ready') return;
                clearTimeout(timer);
                server.off('event', ready);
                resolve();
            };
            server.on('event', ready);
            server.once('exit', () => {
                clearTimeout(timer);
                reject(new Error(t('session.serverExitedOnStart')));
            });
        });
    }

    /** Nahraje program a počká na zastavení na první instrukci (VS Code pak pošle breakpointy). */
    private async startProgram(): Promise<Map<number, { ok: boolean; message?: string }>> {
        const a = this.args!;
        const server = this.server!;
        if (this.sld && this.sld.labels.length) {
            this.symbolFile = path.join(os.tmpdir(), `mbx-next-${process.pid}.sym`);
            fs.writeFileSync(this.symbolFile, this.sld.symbolMap());
            await server.request('loadSymbols', { path: this.symbolFile }).catch((e) => this.out(t('session.labelsFailed', e.message) + '\n'));
        }
        const entry = new Promise<void>((resolve) => (this.onEntry = resolve));
        this.swallowEntry = true;
        await server.request('launch', {
            program: a.program,
            machine: a.machine || 'next',
            stopOnEntry: true,
            rewind: a.rewind === true,
            magicBreakpoint: a.magicBreakpoint !== false,
            ...(fs.existsSync(this.rom) ? { rom: this.rom } : {}),
            ...(a.sdImage ? { sdImage: a.sdImage } : {}),
            ...(a.esxdosRoot ? { esxdosRoot: a.esxdosRoot } : {}),
            ...(a.boot === 'nextzxos'
                ? { boot: 'nextzxos', autorun: a.autorun !== false, syncBack: a.syncBack === true, ...(a.cardFolder ? { cardFolder: a.cardFolder } : {}) }
                : {}),
        });
        const viaNextZxos = a.boot === 'nextzxos';
        if (viaNextZxos) this.out(t('session.waitingForNextZXOS', path.basename(a.program)) + '\n');
        if (this.swallowEntry) {
            // Stroj stál už před nahráním (restart, reload v pauze): server nahrává program až
            // po pár snímcích běhu a nový server se proto po launch rozběhne sám; pojistka pro
            // starší server – rozběhnout, na vstupu zastaví sám.
            const s = await server.request('state').catch(() => undefined);
            if (s?.paused === true && this.swallowEntry) await server.request('continue').catch(() => undefined);
        }
        let timer: NodeJS.Timeout | undefined;
        try {
            // Z NextZXOS přijde vstup až po bootu, bez autorunu až když ho uživatel spustí v Browseru.
            if (viaNextZxos) await entry;
            else await Promise.race([entry, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(t('session.programNotStarted'))), 15000)))]);
        } finally {
            clearTimeout(timer);
        }
        // Klíčová slova z komentářů: výrazy počítá server (návěští už zná), proto až po zastavení na vstupu.
        await this.prepareKeywords();
        const verified = await this.sendAllBreakpoints();
        await this.sendWatchpoints();
        return verified;
    }

    // ------------------------------------------------------------------ přeložit a nahrát znovu

    /** Probíhá „reload“ (vlastní požadavek DAP), krokovat se zatím nedá. */
    isReloading(): boolean {
        return this.reloading !== undefined;
    }

    /**
     * Vlastní požadavek DAP `reload` (příkaz „Přeložit a nahrát znovu“, rozšíření nejdřív přeloží):
     * nové SLD, breakpointy podle něj, program znovu do stroje – sezení i panely zůstávají.
     */
    protected async customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request): Promise<void> {
        if (command !== 'reload') return super.customRequest(command, response, args, request);
        if (this.reloading) {
            this.sendErrorResponse(response, 14, t('session.reloadBusy'));
            return;
        }
        const run = this.reload();
        this.reloading = run;
        try {
            response.body = await run;
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 15, e?.message ?? String(e));
        } finally {
            this.reloading = undefined;
        }
    }

    private async reload(): Promise<{ breakpoints: number; changed: number }> {
        if (!this.server || !this.args) throw new Error(t('session.notDebugging'));
        const a = this.args;
        // Rozjetý krok (požadavek u serveru) nejdřív doběhne, ať jeho odpověď nepřijde do nového programu.
        await Promise.allSettled([...this.verbs]);
        if (!a.program || !fs.existsSync(a.program)) throw new Error(t('session.programNotFound', a.program));
        let sld: SldInfo | undefined;
        if (a.sld) {
            try {
                sld = SldInfo.load(a.sld, a.sourceRoot);
            } catch (e: any) {
                throw new Error(t('session.sldLoadFailed', a.sld, e.message));
            }
        }
        await this.haltForReload();
        // SLD a breakpointy najednou (bez await mezi): setBreakpoints z VS Code, který přijde kdykoli
        // během reloadu, pak už počítá s novým SLD.
        this.sld = sld;
        const changed = relocateBreakpoints(this.sourceBps, sld);
        this.regs = {};
        this.mmu = [];
        this.gotoTargets.clear();
        const verified = await this.startProgram();
        const all = [...this.sourceBps.values()].flat();
        for (const bp of all) this.sendEvent(new BreakpointEvent('changed', this.breakpointFor(bp, verified)));
        // Nový obsah paměti: hex editor, Variables a paměťové pohledy načíst znovu.
        this.sendEvent(new MemoryEvent('0x0', 0, 0x10000));
        this.sendEvent(new InvalidatedEvent(['variables']));
        this.out(t('session.reloaded', path.basename(a.program)) + '\n');
        if (a.stopOnEntry) this.sendEvent(new StoppedEvent('entry', THREAD));
        else await this.server?.request('continue').catch((e) => this.out(e.message + '\n'));
        return { breakpoints: all.length, changed: changed.length };
    }

    /** Před novým nahráním zastavit běžící stroj (zastavení se VS Code nehlásí, hned se nahrává). */
    private async haltForReload(): Promise<void> {
        if (!this.running || !this.server) return;
        const stopped = new Promise<void>((resolve) => {
            this.swallowEntry = true;
            this.onEntry = resolve;
        });
        await this.server.request('pause').catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([stopped, new Promise((r) => (timer = setTimeout(r, 3000)))]);
        clearTimeout(timer);
        this.swallowEntry = false;
        this.onEntry = undefined;
    }

    /** Pohled panelu Next zapsal do paměti: ať VS Code obnoví hex editor a Variables. */
    memoryChanged(addr?: number, length?: number, page?: number): void {
        if (page !== undefined || addr === undefined || length === undefined) this.sendEvent(new MemoryEvent('0x0', 0, 0x10000));
        else this.sendEvent(new MemoryEvent('0x' + (addr & 0xffff).toString(16), 0, Math.max(1, Math.min(length, 0x10000 - (addr & 0xffff)))));
        this.sendEvent(new InvalidatedEvent(['variables']));
    }

    // ------------------------------------------------------------------ klíčová slova v komentářích

    private place(kw: Keyword): string {
        return `${path.basename(kw.file)}:${kw.line}`;
    }

    /** Varování k jednomu klíčovému slovu (stejné jen jednou za spuštění). */
    private keywordWarn(kw: Keyword, message: string): void {
        const once = `${kw.file}:${kw.line}:${message}`;
        if (this.keywordWarned.has(once)) return;
        this.keywordWarned.add(once);
        this.warn(t('session.keywordError', kw.kind, this.place(kw), message));
    }

    /** Číslo z výrazu v komentáři: číslo, návěští, jinak spočítá server. */
    private async keywordValue(expr: string): Promise<number> {
        const n = parseNumber(expr);
        if (n !== undefined) return n;
        const lab = this.sld?.label(expr.trim());
        if (lab) return lab.addr;
        const r = await this.server!.request('evaluate', { expr: this.translateDezog(expr) });
        return (r.value as number) | 0;
    }

    /** Projde WPMEM / LOGPOINT / ASSERTION ze SLD a připraví breakpointy a watchpointy. */
    private async prepareKeywords(): Promise<void> {
        this.keywordBps = [];
        this.keywordWatches = [];
        this.keywordWarned.clear();
        const a = this.args!;
        for (const kw of this.sld?.keywords ?? []) {
            try {
                if (kw.kind === 'ASSERTION' && a.assertions !== false) {
                    // Zastavit, když podmínka NEPLATÍ; prázdná ASSERTION zastaví vždy.
                    const cond = kw.args.trim();
                    this.keywordBps.push({ kw, ...(cond ? { condition: `not (${this.translateDezog(cond)})` } : {}) });
                } else if (kw.kind === 'LOGPOINT' && a.logpoints !== false) {
                    const { group, text } = parseLogpoint(kw.args);
                    const index = this.keywordBps.length;
                    const msg = await this.keywordLogMessage(kw, text);
                    this.keywordBps.push({ kw, logMessage: `\x06${index}\x07${group ? `[${group}] ` : ''}${msg}` });
                } else if (kw.kind === 'WPMEM' && a.wpmem !== false) {
                    const w = parseWpmem(kw.args);
                    const addr = w.addr ? (await this.keywordValue(w.addr)) & 0xffff : kw.addr;
                    const size = w.size ? await this.keywordValue(w.size) : 1;
                    if (size < 1) throw new Error(t('session.keywordBadSize', w.size));
                    const acc = (w.access ?? 'rw').toLowerCase();
                    const access: Access | undefined = acc === 'r' ? 'read' : acc === 'w' ? 'write' : acc === 'rw' || acc === 'wr' ? 'readWrite' : undefined;
                    if (!access) throw new Error(t('session.keywordBadAccess', w.access));
                    this.keywordWatches.push({
                        kw,
                        addr,
                        length: Math.min(size, 0x10000 - addr),
                        access,
                        ...(w.condition ? { condition: this.translateDezog(w.condition) } : {}),
                    });
                }
            } catch (e: any) {
                this.keywordWarn(kw, e.message);
            }
        }
    }

    /**
     * Text LOGPOINT pro server: ${výraz} a ${výraz:formát} → {výraz} se značkami formátu.
     * Výrazy hned zkusí spočítat, ať chyba (neznámé návěští, syntaxe) padne jako varování.
     */
    private async keywordLogMessage(kw: Keyword, text: string): Promise<string> {
        const parts: string[] = [];
        const re = /\$\{([^}]*)\}/g;
        let last = 0;
        let m: RegExpExecArray | null;
        const literal = (s: string) => s.replace(/\{/g, '\x04').replace(/\}/g, '\x05');
        while ((m = re.exec(text))) {
            parts.push(literal(text.slice(last, m.index)));
            last = m.index + m[0].length;
            let expr = m[1].trim();
            let format = 'u';
            const f = /^(.*?)\s*:\s*([A-Za-z]+)$/.exec(expr);
            if (f) {
                if (LOG_FORMATS[f[2].toLowerCase()]) format = LOG_FORMATS[f[2].toLowerCase()];
                else this.keywordWarn(kw, t('session.keywordBadFormat', f[2]));
                expr = f[1];
            }
            const jnext = this.translateDezog(expr);
            try {
                await this.server!.request('evaluate', { expr: jnext });
            } catch (e: any) {
                this.keywordWarn(kw, `\${${expr}}: ${e.message}`);
            }
            parts.push(`\x01${format}${exprSize(expr)}{${jnext}}\x02`);
        }
        parts.push(literal(text.slice(last)));
        return parts.join('');
    }

    /** Výraz z komentáře (syntaxe DeZog) do jazyka JNEXT. */
    private translateDezog(expr: string): string {
        return this.translate(dezogToJnext(expr));
    }

    /** Číslo z logpointu podle formátu (značky z keywordLogMessage / translateLog). */
    private formatLogValue(format: string, size: string, raw: string): string {
        if (raw === '?') return '?';
        const v = parseInt(raw, 10);
        const bits = size === '1' ? 8 : size === '2' ? 16 : v >= -128 && v <= 0xff ? 8 : v >= -32768 && v <= 0xffff ? 16 : 32;
        const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
        const u = bits === 32 ? v >>> 0 : v & mask;
        switch (format) {
            case 'h':
                return hex(u, bits / 4);
            case 's':
                return String(bits === 8 ? (u << 24) >> 24 : bits === 16 ? (u << 16) >> 16 : v | 0);
            case 'c':
                return (u & 0xff) >= 32 && (u & 0xff) < 127 ? String.fromCharCode(u & 0xff) : hex(u & 0xff, 2);
            case 'b':
                return u.toString(2).padStart(bits, '0');
            case 'f':
                return FLAGS.map(([n, bit]) => ((u >> bit) & 1 ? n[0] : '-')).join('');   // SZHPNC
            case 'l':
                return this.sld?.nameFor(u & 0xffff) ?? hex(u & 0xffff, 4);
            default:
                return size === '0' ? String(v) : String(u);
        }
    }

    /** Výstup serveru (logpointy) → text pro Debug Console, u LOGPOINT s místem ve zdrojáku. */
    private outputFromServer(e: ServerEvent): void {
        let text = serverText(e);
        if (!/[\x01\x04-\x07]/.test(text)) {
            this.out(text);
            return;
        }
        let kw: Keyword | undefined;
        const src = SOURCE_RE.exec(text);
        if (src) {
            kw = this.keywordBps[parseInt(src[1], 10)]?.kw;
            text = text.slice(src[0].length);
        }
        text = text
            .replace(MARK_RE, (_, f: string, s: string, v: string) => this.formatLogValue(f, s, v))
            .replace(/\x04/g, '{')
            .replace(/\x05/g, '}');
        const ev = new OutputEvent(text, 'console') as DebugProtocol.OutputEvent;
        if (kw) {
            ev.body.source = new Source(path.basename(kw.file), kw.file);
            ev.body.line = kw.line;
        }
        this.sendEvent(ev);
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        this.sendResponse(response);
        if (this.args?.stopOnEntry) this.sendEvent(new StoppedEvent('entry', THREAD));
        else await this.server?.request('continue').catch((e) => this.out(e.message + '\n'));
    }

    protected async restartRequest(response: DebugProtocol.RestartResponse): Promise<void> {
        if (this.reloading) {
            this.sendErrorResponse(response, 13, t('session.reloadInProgress'));
            return;
        }
        try {
            await this.startProgram();
            await this.sendAllBreakpoints();
            this.sendResponse(response);
            if (this.args?.stopOnEntry) this.sendEvent(new StoppedEvent('entry', THREAD));
            else await this.server?.request('continue');
        } catch (e: any) {
            this.sendErrorResponse(response, 2, e.message);
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        await this.endCardSession();
        this.closeServer();
        this.sendResponse(response);
        this.shutdown();
    }

    protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
        await this.endCardSession();
        this.closeServer();
        this.sendResponse(response);
    }

    /** Start do NextZXOS: autoexec karty zpět, změněné soubory zpět do složky (syncBack) a jejich výpis. */
    private async endCardSession(): Promise<void> {
        if (this.args?.boot !== 'nextzxos' || !this.server) return;
        let timer: NodeJS.Timeout | undefined;
        try {
            const r = await Promise.race([
                this.server.request('endSession'),
                new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 30000))),
            ]);
            if (r?.copied?.length) this.out(t('session.cardSynced', r.folder, r.copied.join(', ')) + '\n');
            if (r?.missing?.length) this.out(t('session.cardMissing', r.missing.join(', ')) + '\n');
        } catch (e: any) {
            this.warn(e?.message ?? String(e));
        } finally {
            clearTimeout(timer);
        }
    }

    private closeServer(): void {
        for (const l of this.watchers) l.detach(this);
        this.server?.close();
        this.server = undefined;
        if (this.symbolFile) fs.rm(this.symbolFile, () => undefined);
    }

    private onServerEvent(e: ServerEvent): void {
        switch (e.event) {
            case 'stopped': {
                this.running = false;
                for (const l of this.watchers) l.state(false);
                if (this.swallowEntry) {
                    this.swallowEntry = false;
                    this.onEntry?.();
                    return;
                }
                this.sendStopped(e);
                break;
            }
            case 'continued':
                this.running = true;
                for (const l of this.watchers) l.state(true);
                if (!this.swallowEntry) this.sendEvent(new ContinuedEvent(THREAD));
                break;
            case 'output':
                this.outputFromServer(e);
                break;
            case 'exited':
                this.sendEvent(new TerminatedEvent());
                break;
        }
    }

    /** Zastavení ze serveru → StoppedEvent s důvodem a popisem (VS Code pak načte registry, zásobník, pozici). */
    private sendStopped(e: ServerEvent): void {
        const ids: number[] = [];
        let assertion: KeywordBp | undefined;
        let watch: Watch | undefined;
        for (const sid of (e.ids as number[]) || []) {
            const d = this.serverToDap.get(sid) ?? this.serverToWatch.get(sid)?.id;
            if (d !== undefined && !ids.includes(d)) ids.push(d);
            const k = this.serverToKeyword.get(sid);
            if (k && !k.logMessage) assertion ??= k;
            const w = this.serverToWatch.get(sid);
            if (w) watch ??= w;
        }
        let reason: string = e.reason;
        let description: string | undefined;
        let text: string | undefined = e.text || undefined;
        const pc = typeof e.pc === 'number' ? e.pc : this.regs.PC;
        switch (e.reason) {
            case 'event':
                // Breakpoint na událost stroje: důvod = popisek filtru z panelu Breakpoints (přeložený).
                reason = eventFilters().find((f) => f.filter === e.eventKind)?.label ?? t('session.stopEvent', e.eventKind);
                break;
            case 'magic':
                reason = t('session.stopMagic');
                // Stroj stojí ZA instrukcí (BREAK = FD 00 ze sjasmplus, DD 01, ZEsarUX ED FF; všechny 2 bajty).
                description = t('session.stopMagicDescription', pc !== undefined ? hex((pc - 2) & 0xffff, 4) : '?');
                break;
            case 'restore':
                reason = t('session.stopRestore');
                description = t('session.stopRestoreDescription');
                // Obnovený stav mění celou paměť: ať se překreslí i paměťové pohledy.
                this.regs = {};
                this.sendEvent(new MemoryEvent('0x0', 0, 0x10000));
                break;
            case 'frameBoundary':
                reason = t('session.stopFrameBoundary');
                description = t('session.stopFrameBoundaryDescription');
                break;
            case 'data breakpoint': {
                // Který watchpoint: z `ids`, podle adresy přístupu (`addr`), jinak jediný WPMEM bez datových breakpointů.
                if (!watch && typeof e.addr === 'number')
                    watch = [...this.userWatches, ...this.keywordWatches].find((w) => e.addr >= w.addr && e.addr < w.addr + w.length);
                if (!watch && !this.userWatches.length && this.keywordWatches.length === 1) watch = this.keywordWatches[0];
                if (watch?.kw) {
                    reason = 'WPMEM';
                    const range = hex(watch.addr, 4) + (watch.length > 1 ? '–' + hex(watch.addr + watch.length - 1, 4) : '');
                    description = t('session.stopWpmem', range, this.place(watch.kw));
                    text = `WPMEM ${watch.kw.args}`.trim();
                    this.out(description + (watch.kw.args ? ` – WPMEM ${watch.kw.args}` : '') + '\n');
                } else if (!watch && !this.userWatches.length && this.keywordWatches.length) {
                    reason = 'WPMEM';
                }
                break;
            }
        }
        if (assertion) {
            const cond = assertion.kw.args.trim();
            reason = t('session.stopAssertion');
            description = cond ? t('session.assertionFailed', cond) : t('session.assertionEmpty');
            text = description;
            this.out(`${description} (${this.place(assertion.kw)})\n`);
        }
        const ev = new StoppedEvent(reason, THREAD, text) as DebugProtocol.StoppedEvent;
        if (description) ev.body.description = description;
        if (ids.length) ev.body.hitBreakpointIds = ids;
        ev.body.allThreadsStopped = true;
        this.sendEvent(ev);
    }

    private out(text: string): void {
        this.sendEvent(new OutputEvent(text, 'console'));
    }

    /** Upozornění, které VS Code ukáže jako oznámení (kategorie „important“). */
    private warn(text: string): void {
        this.sendEvent(new OutputEvent(text + '\n', 'important'));
    }

    // ------------------------------------------------------------------ DAP: breakpointy

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const file = args.source.path || '';
        const list: SourceBp[] = [];
        for (const b of args.breakpoints || []) {
            // I breakpoint bez kódu se pamatuje: po novém překladu (reload) se může ověřit.
            const found = this.sld?.addressesFor(file, b.line);
            list.push({
                id: this.nextBpId++,
                requested: b.line,
                line: found?.line ?? b.line,
                addrs: found ? [...found.addrs] : [],
                condition: b.condition,
                hitCondition: b.hitCondition,
                logMessage: b.logMessage,
            });
        }
        this.sourceBps.set(path.normalize(file).toLowerCase(), list);
        const verified = await this.sendAllBreakpoints();
        const result = list.map((bp) => this.breakpointFor(bp, verified));
        result.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    /** Breakpoint ve zdrojáku pro VS Code (odpověď na setBreakpoints, událost po reloadu). */
    private breakpointFor(bp: SourceBp, verified: Map<number, { ok: boolean; message?: string }>): DebugProtocol.Breakpoint {
        const r = new Breakpoint(bp.addrs.length > 0 && (verified.get(bp.id)?.ok ?? false), bp.line) as DebugProtocol.Breakpoint;
        r.id = bp.id;
        if (bp.addrs.length) {
            r.message = verified.get(bp.id)?.message;
            r.instructionReference = '0x' + bp.addrs[0].addr.toString(16);
        } else {
            r.message = this.sld ? t('session.noInstruction') : t('session.noSld');
        }
        return r;
    }

    protected async setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments): Promise<void> {
        this.instructionBps = [];
        for (const b of args.breakpoints) {
            const addr = (parseNumber(b.instructionReference) ?? 0) + (b.offset ?? 0);
            this.instructionBps.push({ id: this.nextBpId++, requested: 0, line: 0, addrs: [{ addr: addr & 0xffff, page: -1 }], condition: b.condition, hitCondition: b.hitCondition });
        }
        const verified = await this.sendAllBreakpoints();
        response.body = {
            breakpoints: this.instructionBps.map((bp) => ({
                id: bp.id,
                verified: verified.get(bp.id)?.ok ?? false,
                message: verified.get(bp.id)?.message,
                instructionReference: '0x' + bp.addrs[0].addr.toString(16),
            })),
        };
        this.sendResponse(response);
    }

    /** Všechny breakpointy (ze všech souborů a z disassembleru) serveru najednou. */
    private async sendAllBreakpoints(): Promise<Map<number, { ok: boolean; message?: string }>> {
        const out = new Map<number, { ok: boolean; message?: string }>();
        if (!this.server) return out;
        const entries: any[] = [];
        this.serverToDap.clear();
        this.serverToKeyword.clear();
        let sid = 1;
        const all = [...[...this.sourceBps.values()].flat(), ...this.instructionBps];
        for (const bp of all) {
            for (const a of bp.addrs) {
                this.serverToDap.set(sid, bp.id);
                entries.push({
                    id: sid++,
                    addr: a.addr,
                    ...(a.page >= 0 ? { page: a.page } : {}),
                    ...(bp.condition ? { condition: this.translate(bp.condition) } : {}),
                    ...(bp.hitCondition ? { hitCondition: bp.hitCondition } : {}),
                    ...(bp.logMessage ? { logMessage: this.translateLog(bp.logMessage) } : {}),
                });
            }
        }
        // ASSERTION a LOGPOINT z komentářů: na adrese řádku (se stránkou ze SLD).
        for (const k of this.keywordBps) {
            this.serverToKeyword.set(sid, k);
            entries.push({
                id: sid++,
                addr: k.kw.addr,
                ...(k.kw.page >= 0 ? { page: k.kw.page } : {}),
                ...(k.condition ? { condition: k.condition } : {}),
                ...(k.logMessage ? { logMessage: k.logMessage } : {}),
            });
        }
        try {
            const r = await this.server.request('setBreakpoints', { breakpoints: entries });
            for (const b of r.breakpoints as any[]) {
                const k = this.serverToKeyword.get(b.id);
                if (k) {
                    if (!b.verified) this.keywordWarn(k.kw, b.message || 'not verified');
                    continue;
                }
                const d = this.serverToDap.get(b.id);
                if (d === undefined) continue;
                const prev = out.get(d);
                if (!prev || prev.ok) out.set(d, { ok: b.verified, message: b.message });
            }
        } catch (e: any) {
            for (const bp of all) out.set(bp.id, { ok: false, message: e.message });
        }
        return out;
    }

    /** Watchpointy serveru: datové breakpointy z VS Code + WPMEM (server seznam nahrazuje celý). */
    private async sendWatchpoints(): Promise<Map<number, { ok: boolean; message?: string }>> {
        const out = new Map<number, { ok: boolean; message?: string }>();
        if (!this.server) return out;
        this.serverToWatch.clear();
        let sid = WATCH_BASE;
        const all = [...this.userWatches, ...this.keywordWatches];
        const entries = all.map((w) => {
            this.serverToWatch.set(++sid, w);
            return {
                id: sid,
                addr: w.addr,
                length: w.length,
                access: w.access,
                ...(w.condition ? { condition: w.condition } : {}),
                ...(w.hitCondition ? { hitCondition: w.hitCondition } : {}),
            };
        });
        try {
            const r = await this.server.request('setWatchpoints', { watchpoints: entries });
            for (const b of (r?.watchpoints as any[]) || []) {
                const w = this.serverToWatch.get(b.id);
                if (w?.kw && !b.verified) this.keywordWarn(w.kw, b.message || 'not verified');
                if (w?.id !== undefined) out.set(w.id, { ok: b.verified, message: b.message });
            }
        } catch (e: any) {
            for (const w of this.userWatches) out.set(w.id!, { ok: false, message: e.message });
        }
        return out;
    }

    protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
        const opts = new Map<string, string | undefined>();
        for (const f of args.filters || []) opts.set(f, undefined);
        for (const o of args.filterOptions || []) opts.set(o.filterId, o.condition);
        const events: any[] = [];
        let id = 1;
        for (const [kind, condition] of opts) events.push({ id: id++, kind, ...(condition ? { condition: this.translate(condition) } : {}) });
        const result: DebugProtocol.Breakpoint[] = [];
        try {
            const r = await this.server?.request('setEventBreakpoints', { events });
            for (const e of (r?.events as any[]) || []) result.push({ verified: e.verified, message: e.message });
        } catch (e: any) {
            this.out(t('session.eventBreakpointsFailed', e.message) + '\n');
        }
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    protected async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): Promise<void> {
        let addr: number | undefined;
        let len = args.bytes ?? 1;
        if (args.asAddress) addr = parseNumber(args.name);
        else if (args.variablesReference === REF_REGS && ['BC', 'DE', 'HL', 'IX', 'IY', 'SP'].includes(args.name)) {
            addr = this.regs[args.name];   // paměť, na kterou registr ukazuje
        } else {
            addr = this.sld?.label(args.name)?.addr ?? parseNumber(args.name);
        }
        if (addr === undefined) {
            response.body = { dataId: null, description: t('session.addressUnknown') };
        } else {
            len = Math.max(1, Math.min(len, 0x10000 - addr));
            response.body = {
                dataId: `${addr}:${len}`,
                description: `${hex(addr, 4)}${len > 1 ? '–' + hex(addr + len - 1, 4) : ''}`,
                accessTypes: ['read', 'write', 'readWrite'],
                canPersist: true,
            };
        }
        this.sendResponse(response);
    }

    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {
        this.userWatches = args.breakpoints.map((b) => {
            const [a, l] = b.dataId.split(':').map((x) => parseInt(x, 10));
            return {
                id: this.nextBpId++,
                addr: a,
                length: l || 1,
                access: (b.accessType || 'write') as Access,
                ...(b.condition ? { condition: this.translate(b.condition) } : {}),
                ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
            };
        });
        const verified = await this.sendWatchpoints();
        response.body = {
            breakpoints: this.userWatches.map((w) => ({
                id: w.id,
                verified: verified.get(w.id!)?.ok ?? false,
                message: verified.get(w.id!)?.message,
            })),
        };
        this.sendResponse(response);
    }

    // ------------------------------------------------------------------ DAP: běh

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: [new Thread(THREAD, 'Z80')] };
        this.sendResponse(response);
    }

    private async verb(response: DebugProtocol.Response, cmd: string, args: Record<string, any> = {}): Promise<void> {
        if (this.reloading) {
            this.sendErrorResponse(response, 13, t('session.reloadInProgress'));
            return;
        }
        const req = this.server?.request(cmd, args);
        if (req) this.verbs.add(req);
        try {
            await req;
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 3, e.message);
        } finally {
            if (req) this.verbs.delete(req);
        }
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        response.body = { allThreadsContinued: true };
        return this.verb(response, 'continue');
    }
    protected nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        return this.verb(response, 'stepOver');
    }
    protected stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        return this.verb(response, 'stepIn');
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse): Promise<void> {
        return this.verb(response, 'stepOut');
    }
    protected async stepBackRequest(response: DebugProtocol.StepBackResponse): Promise<void> {
        if (this.args?.rewind !== true) {
            this.sendErrorResponse(response, 5, t('session.stepBackDisabled'));
            return;
        }
        return this.verb(response, 'stepBack', { count: 1 });
    }
    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): void {
        this.sendErrorResponse(response, 4, t('session.reverseContinueUnavailable'));
    }
    protected pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        return this.verb(response, 'pause');
    }

    /** Jump to Cursor: řádek → adresy podle SLD (víc adres = víc cílů; namapovaná stránka první). */
    protected async gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): Promise<void> {
        const found = this.sld?.addressesFor(args.source.path || '', args.line);
        const targets: DebugProtocol.GotoTarget[] = [];
        this.gotoTargets.clear();
        if (found) {
            await this.refresh().catch(() => undefined);
            const mapped = (a: Address) => a.page < 0 || this.pageOf(a.addr) === a.page;
            const addrs = [...found.addrs].sort((a, b) => Number(mapped(b)) - Number(mapped(a)));
            addrs.forEach((a, i) => {
                const id = i + 1;
                this.gotoTargets.set(id, a.addr);
                const label = a.page < 0 ? hex(a.addr, 4) : t(mapped(a) ? 'session.gotoTarget' : 'session.gotoTargetUnmapped', hex(a.addr, 4), a.page);
                targets.push({ id, label, line: found.line, instructionPointerReference: '0x' + a.addr.toString(16) });
            });
        }
        response.body = { targets };
        this.sendResponse(response);
    }

    protected async gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): Promise<void> {
        const addr = this.gotoTargets.get(args.targetId);
        if (addr === undefined || !this.server) {
            this.sendErrorResponse(response, 12, t('session.noInstruction'));
            return;
        }
        try {
            await this.server.request('setRegister', { name: 'PC', value: addr });
            this.regs = {};
            this.sendResponse(response);
            const ev = new StoppedEvent('goto', THREAD) as DebugProtocol.StoppedEvent;
            ev.body.allThreadsStopped = true;
            this.sendEvent(ev);
        } catch (e: any) {
            this.sendErrorResponse(response, 12, e.message);
        }
    }

    // ------------------------------------------------------------------ DAP: stav stroje

    private async refresh(): Promise<void> {
        const r = await this.server!.request('registers');
        this.regs = r.registers;
        const m = await this.server!.request('mmu');
        this.mmu = (m.slots as any[]).map((s) => s.page);
    }

    private pageOf = (addr: number): number => this.mmu[(addr >> 13) & 7] ?? -1;

    private frameFor(id: number, addr: number, name?: string): StackFrame {
        const loc = this.sld?.locate(addr, this.pageOf);
        const label = this.sld?.nameFor(addr);
        const title = name || label || hex(addr, 4);
        const f = loc
            ? new StackFrame(id, title, new Source(path.basename(loc.file), loc.file), loc.line, 1)
            : new StackFrame(id, `${title}  ${hex(addr, 4)}`);
        (f as DebugProtocol.StackFrame).instructionPointerReference = '0x' + addr.toString(16);
        if (!loc) (f as DebugProtocol.StackFrame).presentationHint = 'subtle';
        return f;
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
        try {
            await this.refresh();
            const frames: StackFrame[] = [this.frameFor(0, this.regs.PC)];
            const cs = await this.server!.request('callStack');
            const calls = [...(cs.frames as any[])].reverse();
            calls.forEach((c, i) => frames.push(this.frameFor(i + 1, c.caller)));
            response.body = { stackFrames: frames, totalFrames: frames.length };
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 5, e.message);
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
        response.body = {
            scopes: [
                new Scope(t('session.scopeRegisters'), REF_REGS, false),
                new Scope(t('session.scopeFlags'), REF_FLAGS, false),
                new Scope(t('session.scopeShadowRegisters'), REF_ALT, true),
                new Scope(t('session.scopeMachine'), REF_MACHINE, true),
            ],
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        const vars: DebugProtocol.Variable[] = [];
        const reg = (n: string, bits: 8 | 16 = 16) => {
            const v = this.regs[n] ?? 0;
            const lab = bits === 16 ? this.sld?.nameFor(v) : undefined;
            vars.push({ name: n, value: fmt(v, bits) + (lab && n !== 'AF' ? `  ${lab}` : ''), variablesReference: 0, memoryReference: bits === 16 ? '0x' + v.toString(16) : undefined });
        };
        try {
            if (!Object.keys(this.regs).length) await this.refresh();
            if (args.variablesReference === REF_REGS) {
                for (const n of MAIN_REGS) reg(n);
                reg('I', 8);
                reg('R', 8);
                vars.push({ name: 'IM', value: String(this.regs.IM), variablesReference: 0 });
                vars.push({ name: 'IFF1', value: String(this.regs.IFF1), variablesReference: 0 });
            } else if (args.variablesReference === REF_FLAGS) {
                const f = (this.regs.AF ?? 0) & 0xff;
                for (const [n, bit] of FLAGS) vars.push({ name: n, value: (f >> bit) & 1 ? '1' : '0', variablesReference: 0 });
            } else if (args.variablesReference === REF_ALT) {
                for (const n of ALT_REGS) reg(n);
            } else if (args.variablesReference === REF_MACHINE) {
                const s = await this.server!.request('state');
                vars.push({ name: t('session.varFrame'), value: String(s.frame), variablesReference: 0 });
                vars.push({ name: t('session.varTstates'), value: String(s.tstates), variablesReference: 0 });
                this.mmu.forEach((p, i) =>
                    vars.push({ name: `MMU${i} (${hex(i * 0x2000, 4)})`, value: t('session.varMmuPage', p, hex(p, 2)), variablesReference: 0 }));
            }
            response.body = { variables: vars };
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 6, e.message);
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        try {
            const v = parseNumber(args.value);
            if (v === undefined) throw new Error(t('session.enterNumber'));
            if (args.variablesReference === REF_FLAGS) {
                const bit = FLAGS.find(([n]) => n === args.name)?.[1];
                if (bit === undefined) throw new Error(t('session.unknownFlag'));
                const f = ((this.regs.AF ?? 0) & 0xff & ~(1 << bit)) | ((v ? 1 : 0) << bit);
                await this.server!.request('setRegister', { name: 'F', value: f });
                response.body = { value: v ? '1' : '0' };
            } else {
                await this.server!.request('setRegister', { name: args.name, value: v });
                await this.refresh();
                const bits = args.name.length === 1 || ['I', 'R', 'IM'].includes(args.name) ? 8 : 16;
                response.body = { value: fmt(v, bits as 8 | 16) };
            }
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 7, e.message);
        }
    }

    /** Výraz z VS Code do jazyka JNEXT: návěští → @návěští, registry velkými písmeny, $hex. */
    private translate(expr: string): string {
        return expr.replace(/@?[A-Za-z_][A-Za-z0-9_.]*'?/g, (tok, offset: number, all: string) => {
            if (tok.startsWith('@')) return tok;
            if (offset > 0 && /[$#0-9]/.test(all[offset - 1])) return tok;   // část čísla ($FF, 0x10)
            const up = tok.toUpperCase();
            // JNEXT zná stínové registry jako AF2…HL2 a nezná poloviny IX/IY
            const shadow = /^(AF|BC|DE|HL)'$/.exec(up);
            if (shadow) return shadow[1] + '2';
            const half = /^I([XY])([HL])$/.exec(up);
            if (half) return half[2] === 'H' ? `(I${half[1]} >> 8)` : `(I${half[1]} & $FF)`;
            if (REG_NAMES.has(up)) return up;
            const lab = this.sld?.label(tok);
            // lokální návěští (main_loop.wait) JNEXT jménem nezná: dosadí se adresa
            if (lab) return tok.includes('.') ? '$' + lab.addr.toString(16).toUpperCase() : '@' + tok;
            return tok;
        });
    }

    /** Logpoint z VS Code: {výraz} nebo {výraz:hex} (formáty jako u LOGPOINT: hex, signed, char, bits, flags, labels). */
    private translateLog(msg: string): string {
        return msg.replace(/\{([^}]*)\}/g, (_, e: string) => {
            const f = /^(.*?)\s*:\s*([A-Za-z]+)$/.exec(e);
            const format = f ? LOG_FORMATS[f[2].toLowerCase()] : undefined;
            return format ? `\x01${format}${exprSize(f![1])}{${this.translate(f![1])}}\x02` : `{${this.translate(e)}}`;
        });
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        try {
            const dump = args.context === 'repl' ? /^m\s+(.+?)(?:\s*,\s*(.+))?$/i.exec(args.expression.trim()) : null;
            if (dump) {
                response.body = { result: await this.memoryDump(dump[1], dump[2]), variablesReference: 0 };
                this.sendResponse(response);
                return;
            }
            const lab = this.sld?.label(args.expression.trim());
            const r = await this.server!.request('evaluate', { expr: this.translate(args.expression) });
            const v = (r.value as number) | 0;
            let text = v >= 0 && v <= 0xffff ? fmt(v, v > 0xff || lab ? 16 : 8) : String(v);
            if (lab || args.context === 'hover') {
                // U návěští i obsah paměti: bajt a slovo na adrese.
                const m = await this.server!.request('readMemory', { addr: v & 0xffff, length: 2 });
                const b = Buffer.from(m.data, 'base64');
                if (b.length >= 2) text += `  → [${hex(b[0], 2)}] [${hex(b[0] | (b[1] << 8), 4)}]`;
            }
            response.body = { result: text, variablesReference: 0, memoryReference: '0x' + (v & 0xffff).toString(16) };
            this.sendResponse(response);
        } catch (e: any) {
            if (args.context === 'hover') {
                response.success = false;
                this.sendResponse(response);
            } else this.sendErrorResponse(response, 8, e instanceof ServerError ? e.message : String(e.message));
        }
    }

    /** Příkaz Debug Console `m adresa[, délka]`: hex výpis paměti (výchozí 128 B), s návěštími. */
    private async memoryDump(addrExpr: string, lenExpr?: string): Promise<string> {
        const value = async (e: string) => ((await this.server!.request('evaluate', { expr: this.translate(e) })).value as number) | 0;
        const start = (await value(addrExpr)) & 0xffff;
        const len = Math.max(1, Math.min(lenExpr ? await value(lenExpr) : 128, 0x10000 - start, 4096));
        const r = await this.server!.request('readMemory', { addr: start, length: len });
        const b = Buffer.from(r.data, 'base64');
        const lines: string[] = [];
        for (let o = 0; o < b.length; o += 16) {
            const row = b.subarray(o, o + 16);
            const bytes = [...row].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(47);
            const text = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
            const lab = this.sld?.nameFor(start + o);
            lines.push(`${hex(start + o, 4)}  ${bytes}  ${text}${lab ? '  ' + lab : ''}`);
        }
        return lines.join('\n');
    }

    // ------------------------------------------------------------------ DAP: paměť a disassembler

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        try {
            const start = ((parseNumber(args.memoryReference) ?? 0) + (args.offset ?? 0)) & 0xffff;
            const count = Math.min(args.count, 0x10000 - start);
            const r = await this.server!.request('readMemory', { addr: start, length: count });
            response.body = { address: '0x' + start.toString(16), data: r.data, unreadableBytes: args.count - count };
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 9, e.message);
        }
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        try {
            const start = ((parseNumber(args.memoryReference) ?? 0) + (args.offset ?? 0)) & 0xffff;
            const r = await this.server!.request('writeMemory', { addr: start, data: args.data });
            response.body = { bytesWritten: r.written };
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 10, e.message);
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
        try {
            const base = ((parseNumber(args.memoryReference) ?? 0) + (args.offset ?? 0)) & 0xffff;
            const before = Math.max(0, -(args.instructionOffset ?? 0));
            const want = args.instructionCount;
            // Instrukce mají 1–4 bajty: začít o kus dřív a najít tu, která začíná přesně na `base`.
            let lines: any[] = [];
            let idx = -1;
            for (const back of before ? [before * 3, before * 2, before * 4, before] : [0]) {
                const from = Math.max(0, base - back);
                const r = await this.server!.request('disassemble', { addr: from, count: before + want + 8 });
                lines = r.lines;
                idx = lines.findIndex((l) => l.addr === base);
                if (idx >= 0) break;
            }
            if (idx < 0) {
                lines = (await this.server!.request('disassemble', { addr: base, count: want })).lines;
                idx = 0;
            }
            const first = idx + (args.instructionOffset ?? 0);
            const out: DebugProtocol.DisassembledInstruction[] = [];
            for (let i = first; out.length < want; ++i) {
                const l = lines[i];
                if (!l) {
                    out.push({ address: '0x' + ((base + i) & 0xffff).toString(16), instruction: '', presentationHint: 'invalid' });
                    continue;
                }
                const ins: DebugProtocol.DisassembledInstruction = {
                    address: '0x' + l.addr.toString(16),
                    instructionBytes: l.bytes,
                    instruction: l.text,
                };
                const loc = this.sld?.locate(l.addr, this.pageOf);
                if (loc) {
                    ins.location = new Source(path.basename(loc.file), loc.file);
                    ins.line = loc.line;
                }
                const sym = this.sld?.nameFor(l.addr);
                if (sym && !sym.includes('+')) ins.symbol = sym;
                out.push(ins);
            }
            response.body = { instructions: out };
            this.sendResponse(response);
        } catch (e: any) {
            this.sendErrorResponse(response, 11, e.message);
        }
    }
}
