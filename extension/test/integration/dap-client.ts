// Klient DAP pro integrační testy: NextDebugSession v tomto procesu (přes proudy, jako VS Code),
// proti skutečnému serveru build/release/bin/mbx-next-server.exe. Přímé příkazy serveru jdou přes
// session.serverRequest (jako panely rozšíření).
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { setLanguage } from '../../src/i18n';
import { NextDebugSession, ScreenSink } from '../../src/session';

export const REPO = path.resolve(__dirname, '..', '..');
export const EXT = path.join(REPO, 'extension');
export const FIXTURES = path.join(EXT, 'test', 'fixtures');
export const SERVER = process.env.MBX_NEXT_SERVER || path.join(REPO, 'build', 'release', 'bin', 'mbx-next-server.exe');
/** Důvod přeskočení integračních testů (false = server je). */
export const NO_SERVER: string | false = fs.existsSync(SERVER) ? false : `chybí server ${SERVER}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Program z test/fixtures (předpřeložený) se zdrojákem v `sourceDir`. */
export function program(name: string, sourceDir: string) {
    return {
        program: path.join(FIXTURES, name + '.nex'),
        sld: path.join(FIXTURES, name + '.sld'),
        sourceRoot: sourceDir,
        source: path.join(sourceDir, name + '.asm'),
    };
}

/** Číslo řádku (od 1) prvního řádku zdrojáku s daným textem. */
export function lineOf(file: string, text: string, from = 1): number {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l, k) => k + 1 >= from && l.includes(text));
    if (i < 0) throw new Error(`${path.basename(file)}: řádek s „${text}“ nenalezen`);
    return i + 1;
}

/** Číslo z výsledku evaluate („$05 (5)…“ → 5, „70000“ → 70000). */
export function valueOf(result: string): number {
    const m = /^\$([0-9A-F]+)/.exec(result) ?? /^(-?\d+)/.exec(result);
    if (!m) throw new Error('není číslo: ' + result);
    return result.startsWith('$') ? parseInt(m[1], 16) : parseInt(m[1], 10);
}

interface Waiter {
    name: string;
    pred: (m: any) => boolean;
    resolve: (m: any) => void;
}

/** Obraz a zvuk ze serveru (ScreenSink) – počty pro testy. */
export class CountingSink implements ScreenSink {
    frames = 0;
    lastFrame?: { width: number; height: number; length: number };
    audioBlocks = 0;
    audioBytes = 0;
    attach(): void {}
    detach(): void {}
    state(): void {}
    frame(width: number, height: number, rgba: Buffer): void {
        this.frames++;
        this.lastFrame = { width, height, length: rgba.length };
    }
    audio(samples: Buffer): void {
        this.audioBlocks++;
        this.audioBytes += samples.length;
    }
}

export class DapClient {
    readonly session: NextDebugSession;
    readonly sink = new CountingSink();
    /** všechny události (output, stopped …) v pořadí příchodu */
    readonly events: any[] = [];
    private seq = 1;
    private buf = Buffer.alloc(0);
    private pending = new Map<number, (m: any) => void>();
    private waiters: Waiter[] = [];
    private toAdapter = new PassThrough();
    private fromAdapter = new PassThrough();

    constructor(lang = 'en') {
        setLanguage(lang);
        this.session = new NextDebugSession(SERVER, this.sink);
        // bez toho by DebugSession po disconnect ukončil celý proces (process.exit)
        this.session.setRunAsServer(true);
        this.session.start(this.toAdapter, this.fromAdapter);
        this.fromAdapter.on('data', (d: Buffer) => this.onData(d));
    }

    private onData(d: Buffer): void {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            const h = this.buf.indexOf('\r\n\r\n');
            if (h < 0) return;
            const len = +/Content-Length: (\d+)/.exec(this.buf.subarray(0, h).toString())![1];
            if (this.buf.length < h + 4 + len) return;
            const msg = JSON.parse(this.buf.subarray(h + 4, h + 4 + len).toString('utf8'));
            this.buf = this.buf.subarray(h + 4 + len);
            if (msg.type === 'response') {
                this.pending.get(msg.request_seq)?.(msg);
                this.pending.delete(msg.request_seq);
            } else if (msg.type === 'event') {
                this.events.push(msg);
                const i = this.waiters.findIndex((w) => w.name === msg.event && w.pred(msg));
                if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
            }
        }
    }

    /** Požadavek DAP → odpověď (i neúspěšná). */
    request(command: string, args: any = {}): Promise<any> {
        const seq = this.seq++;
        const body = JSON.stringify({ seq, type: 'request', command, arguments: args });
        const p = new Promise<any>((resolve) => this.pending.set(seq, resolve));
        this.toAdapter.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        return p;
    }

    /** Požadavek, který musí uspět; vrací body. */
    async ok(command: string, args: any = {}): Promise<any> {
        const r = await this.request(command, args);
        if (!r.success) throw new Error(`${command}: ${r.message}`);
        return r.body;
    }

    /** Příští událost (jen budoucí – čekání založit před akcí, která ji vyvolá). */
    next(name: string, pred: (m: any) => boolean = () => true, ms = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            const w: Waiter = { name, pred, resolve: (m) => (clearTimeout(timer), resolve(m)) };
            const timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                reject(new Error(`událost ${name} nepřišla do ${ms} ms`));
            }, ms);
            this.waiters.push(w);
        });
    }

    /** Výstupy (Debug Console) od indexu `from` v this.events. */
    outputs(from = 0, category?: string): any[] {
        return this.events.slice(from).filter((e) => e.event === 'output' && (!category || e.body.category === category));
    }

    /** Akce, která má skončit zastavením: vrací událost stopped. */
    async until(action: () => Promise<any>, ms = 15000): Promise<any> {
        const stopped = this.next('stopped', () => true, ms);
        await action();
        return stopped;
    }

    cont(ms?: number): Promise<any> {
        return this.until(() => this.ok('continue', { threadId: 1 }), ms);
    }

    /** Horní rámec zásobníku. */
    async top(): Promise<any> {
        return (await this.ok('stackTrace', { threadId: 1 })).stackFrames[0];
    }

    async evaluate(expression: string, context = 'watch'): Promise<string> {
        return (await this.ok('evaluate', { expression, context, frameId: 0 })).result;
    }

    /** initialize → launch → configurationDone se stopOnEntry; vrací se po zastavení na vstupu. */
    async launch(args: Record<string, any>, breakpoints?: { source: string; lines: any[] }): Promise<void> {
        await this.ok('initialize', { adapterID: 'mbx-next', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
        const r = await this.request('launch', { stopOnEntry: true, ...args });
        if (!r.success) throw new Error('launch: ' + r.message);
        if (breakpoints) await this.ok('setBreakpoints', { source: { path: breakpoints.source }, breakpoints: breakpoints.lines });
        if (args.stopOnEntry === false) await this.ok('configurationDone');
        else await this.until(() => this.ok('configurationDone'));
    }

    server(cmd: string, args: Record<string, any> = {}): Promise<any> {
        return this.session.serverRequest(cmd, args);
    }

    async close(): Promise<void> {
        await this.request('disconnect', {}).catch(() => undefined);
        await sleep(300);
    }
}
