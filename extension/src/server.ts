// Spojení s ladicím serverem (mbx-next-server): podproces, zprávy v rámcích přes stdin/stdout.
// [u32 délka][u8 typ][data], délka = 1 + délka dat; typ 1 JSON, 2 obraz, 3 zvuk (server/main.cpp).

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { t } from './i18n';

const JSON_MSG = 1;
const VIDEO = 2;
const AUDIO = 3;

export interface ServerEvent {
    event: string;
    [key: string]: any;
}

/** Odpověď serveru, která hlásí chybu. */
export class ServerError extends Error {}

/**
 * Události: 'event' (ServerEvent), 'frame' (šířka, výška, RGBA), 'audio' (Int16 stereo),
 * 'stderr' (text), 'exit' (kód).
 */
export class ServerConnection extends EventEmitter {
    private proc: ChildProcess;
    private buf: Buffer = Buffer.alloc(0);
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private exited = false;

    constructor(exe: string, cwd?: string) {
        super();
        this.proc = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
        this.proc.stderr!.on('data', (d: Buffer) => this.emit('stderr', d.toString()));
        this.proc.on('error', (e) => this.emit('stderr', t('session.serverStartFailed', e.message) + '\n'));
        this.proc.on('exit', (code) => {
            this.exited = true;
            for (const p of this.pending.values()) p.reject(new ServerError(t('session.serverExited')));
            this.pending.clear();
            this.emit('exit', code ?? 0);
        });
    }

    /** Příkaz s odpovědí; odmítnutí (ok: false) jako výjimka ServerError. */
    request(cmd: string, args: Record<string, any> = {}): Promise<any> {
        if (this.exited) return Promise.reject(new ServerError(t('session.serverNotRunning')));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ ...args, cmd, id });
        });
    }

    /** Příkaz bez odpovědi (klávesy, myš). */
    send(cmd: string, args: Record<string, any> = {}): void {
        if (!this.exited) this.write({ ...args, cmd });
    }

    close(): void {
        if (this.exited) return;
        this.send('quit');
        this.proc.stdin!.end();
        setTimeout(() => {
            if (!this.exited) this.proc.kill();
        }, 2000);
    }

    private write(msg: object): void {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const head = Buffer.alloc(5);
        head.writeUInt32LE(body.length + 1, 0);
        head[4] = JSON_MSG;
        this.proc.stdin!.write(Buffer.concat([head, body]));
    }

    private onData(d: Buffer): void {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        while (this.buf.length >= 5) {
            const len = this.buf.readUInt32LE(0);
            if (this.buf.length < 4 + len) break;
            const type = this.buf[4];
            const data = this.buf.subarray(5, 4 + len);
            this.buf = this.buf.subarray(4 + len);
            if (type === JSON_MSG) this.onJson(data);
            else if (type === VIDEO) this.emit('frame', data.readUInt16LE(0), data.readUInt16LE(2), Buffer.from(data.subarray(4)));
            else if (type === AUDIO) this.emit('audio', Buffer.from(data));
        }
    }

    private onJson(data: Buffer): void {
        let msg: any;
        try {
            msg = JSON.parse(data.toString('utf8'));
        } catch {
            return;
        }
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg);
            else p.reject(new ServerError(msg.error || t('session.serverError')));
        } else if (msg.event) {
            this.emit('event', msg as ServerEvent);
        }
    }
}
