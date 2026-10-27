// Panel „Next“ (webview): záložky s pohledy na hardware Nextu – sprity, palety, tilemapa, Copper…
// Pohledy jsou soubory media/views/*.js nad frameworkem media/next.js (smlouva v docs/next-views.md);
// data si berou ze serveru přes tento panel, který povolené dotazy předává sezení.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { dictionaryScript, language, t } from './i18n';
import { NextDebugSession, SessionListener } from './session';
import type { SldInfo } from './sld';

/** Obdélník v prostoru obrazu 320 × 256 (včetně okraje). */
export interface HighlightRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Příkazy serveru, které smí pohledy volat (čtou stav stroje; writeMemory pro pohled Paměť, espClear pro WiFi). */
export const ALLOWED = new Set([
    'sprites', 'patternRam', 'palettes', 'copper', 'renderLayer', 'readMemory', 'nextregs', 'mmu', 'state', 'registers',
    'raster', 'soundState', 'pageUsage', 'writeMemory', 'espLog', 'espState', 'espClear',
]);

/** Dotazy, které vyřídí rozšíření samo (bez serveru). */
export const LOCAL = new Set(['symbols']);

/** Odpověď na dotaz `symbols`: návěští a počty řádků kódu v 8K stránkách ze SLD (bez SLD prázdné). */
export function symbolsFor(sld: SldInfo | undefined): { labels: Array<{ name: string; addr: number; page: number }>; codePages: Record<string, number> } {
    if (!sld) return { labels: [], codePages: {} };
    return {
        labels: sld.labels.map((l) => ({ name: l.name, addr: l.addr, page: l.page })),
        codePages: sld.codePageCounts(),
    };
}

export class NextViewPanel implements SessionListener {
    private panel?: vscode.WebviewPanel;
    private session?: NextDebugSession;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly highlight: (rect: HighlightRect | null) => void,
        /** Je-li obrazovka emulátoru otevřená, aktivuje její skupinu a vrátí true. */
        private readonly focusScreen: () => boolean = () => false,
    ) {}

    attach(session: NextDebugSession): void {
        this.session = session;
        this.post({ type: 'attached' });
    }

    detach(session: NextDebugSession): void {
        if (this.session !== session) return;
        this.session = undefined;
        this.highlight(null);
        this.post({ type: 'detached' });
    }

    state(running: boolean): void {
        this.post({ type: running ? 'continued' : 'stopped' });
    }

    /**
     * Otevře panel vedle editoru. Je-li otevřená obrazovka emulátoru, do nové skupiny POD ní –
     * jinak by ji panel ve stejné skupině překryl jako další záložka.
     */
    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        let column = vscode.ViewColumn.Beside;
        if (this.focusScreen()) {
            await vscode.commands.executeCommand('workbench.action.newGroupBelow');
            column = vscode.ViewColumn.Active;
        }
        if (this.panel) return;   // mezitím otevřený (dvojí příkaz)
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel = vscode.window.createWebviewPanel(
            'mbxNextView',
            'Next',
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
        );
        this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
        this.panel.webview.html = this.html(this.panel.webview, media);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.highlight(null);
        });
    }

    /** Nový obsah webview (změna jazyka); panel po načtení pošle "ready" a dostane zpět stav. */
    rebuild(): void {
        if (!this.panel) return;
        this.highlight(null);
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel.webview.html = this.html(this.panel.webview, media);
    }

    private post(msg: any): void {
        void this.panel?.webview.postMessage(msg);
    }

    private onMessage(m: any): void {
        switch (m?.type) {
            case 'ready': {
                // Panel otevřený za běhu sezení: hned stav, ať se záložka naplní.
                const s = this.session;
                this.post({ type: s ? 'attached' : 'detached' });
                if (s) this.post({ type: s.isRunning() ? 'continued' : 'stopped' });
                break;
            }
            case 'request':
                void this.request(m);
                break;
            case 'highlight':
                this.highlight(validRect(m.rect));
                break;
        }
    }

    /** Dotaz pohledu na server; odpověď bez `id` a `ok` serveru jako `result`. */
    private async request(m: any): Promise<void> {
        const reply = (ok: boolean, body: object) => this.post({ type: 'response', id: m.id, ok, ...body });
        const cmd = String(m.cmd);
        if (!ALLOWED.has(cmd) && !LOCAL.has(cmd)) return reply(false, { error: t('extension.commandNotAllowed', cmd) });
        const args = m.args && typeof m.args === 'object' && !Array.isArray(m.args) ? m.args : {};
        const s = this.session;
        if (!s) return reply(false, { error: t('session.notDebugging') });
        if (cmd === 'symbols') return reply(true, { result: symbolsFor(s.getSld()) });
        try {
            const { id: _id, ok: _ok, ...result } = await s.serverRequest(cmd, args);
            reply(true, { result });
            if (cmd === 'writeMemory') {
                const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : undefined);
                const written = num(result.written) ?? (typeof args.data === 'string' ? Buffer.from(args.data, 'base64').length : undefined);
                s.memoryChanged(num(args.addr), written, num(args.page));
            }
        } catch (e: any) {
            reply(false, { error: e?.message || String(e) });
        }
    }

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p));
        // Pohledy zjištěné za běhu: každý soubor media/views/*.js se zaregistruje přes NextView.register.
        let views: string[] = [];
        try {
            views = fs.readdirSync(vscode.Uri.joinPath(media, 'views').fsPath).filter((f) => f.endsWith('.js')).sort();
        } catch {
            // složka s pohledy chybí → panel bez záložek
        }
        const scripts = ['next.js', ...views.map((v) => 'views/' + v)]
            .map((f) => `<script nonce="${nonce}" src="${uri(...f.split('/'))}"></script>`)
            .join('\n');
        const l10n = dictionaryScript(nonce, 'next.', 'sprites.', 'patterns.', 'palettes.', 'layers.', 'layer2.', 'tilemap.', 'copper.', 'nextreg.', 'memory.', 'memmap.', 'sound.', 'esp.');
        // Styly 'unsafe-inline': pohledy si vkládají vlastní <style> a atribut style (api.el).
        return `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('next.css')}">
<title>Next</title>
</head>
<body>
<div id="bar">
  <div id="tabs" role="tablist"></div>
  <span id="status">${esc(t('next.waiting'))}</span>
  <button id="refresh" title="${esc(t('next.refreshTooltip'))}">${esc(t('next.refresh'))}</button>
  <label id="liveLabel" title="${esc(t('next.liveTooltip'))}"><input type="checkbox" id="live"> ${esc(t('next.live'))}</label>
</div>
<div id="content"></div>
${l10n}
${scripts}
</body>
</html>`;
    }
}

/** Text do HTML (překlady můžou obsahovat < & "). */
export function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Obdélník z webview (nedůvěryhodná data) nebo null. */
function validRect(r: any): HighlightRect | null {
    if (!r || typeof r !== 'object') return null;
    const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : NaN);
    const rect = { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) };
    return Object.values(rect).some(isNaN) ? null : rect;
}
