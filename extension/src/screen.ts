// Panel s obrazovkou emulátoru (webview): obraz, zvuk, klávesnice a myš pro běžící sezení.

import * as vscode from 'vscode';
import { dictionaryScript, language, t } from './i18n';
import { esc, type HighlightRect } from './nextview';
import { NextDebugSession, ScreenSink } from './session';

export class ScreenPanel implements ScreenSink {
    private panel?: vscode.WebviewPanel;
    private session?: NextDebugSession;
    private ready = false;
    private speedTimer?: NodeJS.Timeout;
    private lastFrame?: { frame: number; time: number };
    private highlightRect: HighlightRect | null = null;

    constructor(private readonly extensionUri: vscode.Uri) {}

    attach(session: NextDebugSession): void {
        this.session = session;
        this.show(true);
        this.post({ type: 'attached' });
    }

    detach(session: NextDebugSession): void {
        if (this.session !== session) return;
        this.session = undefined;
        this.stopSpeed();
        this.post({ type: 'detached' });
    }

    frame(width: number, height: number, rgba: Buffer): void {
        if (!this.panel?.visible || !this.ready) return;
        this.post({ type: 'frame', width, height, data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
    }

    audio(samples: Buffer): void {
        if (!this.panel || !this.ready) return;
        this.post({ type: 'audio', data: new Int16Array(samples.buffer, samples.byteOffset, samples.byteLength >> 1) });
    }

    state(running: boolean): void {
        this.post({ type: 'state', running });
        this.stopSpeed();
        if (running) this.speedTimer = setInterval(() => void this.measureSpeed(), 1000);
    }

    /** Zvýraznění obdélníku (prostor 320 × 256) z panelu Next; null zruší. */
    highlight(rect: HighlightRect | null): void {
        this.highlightRect = rect;
        this.post({ type: 'highlight', rect });
    }

    private stopSpeed(): void {
        clearInterval(this.speedTimer);
        this.speedTimer = undefined;
        this.lastFrame = undefined;
    }

    /** Snímků emulace za sekundu podle čítače snímků serveru. */
    private async measureSpeed(): Promise<void> {
        const frame = await this.session?.frameNumber();
        if (frame === undefined || !this.speedTimer) return;
        const time = Date.now();
        const prev = this.lastFrame;
        this.lastFrame = { frame, time };
        if (prev && frame >= prev.frame) this.post({ type: 'speed', fps: Math.round(((frame - prev.frame) * 1000) / (time - prev.time)) });
    }

    /** Je-li panel otevřený, ukáže ho a aktivuje jeho skupinu (panel Next se pak otevře pod ním). */
    focusGroup(): boolean {
        if (!this.panel) return false;
        this.panel.reveal(this.panel.viewColumn, false);
        return true;
    }

    /** Otevře panel (vedle editoru, bez převzetí fokusu při startu ladění). */
    show(preserveFocus = false): void {
        if (this.panel) {
            this.panel.reveal(undefined, preserveFocus);
            return;
        }
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel = vscode.window.createWebviewPanel(
            'mbxNextScreen',
            'ZX Spectrum Next',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
        );
        this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
        this.ready = false;
        this.panel.webview.html = this.html(this.panel.webview, media);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
        });
    }

    /** Nový obsah webview (změna jazyka); panel po načtení pošle "ready" a dostane zpět stav. */
    rebuild(): void {
        if (!this.panel) return;
        this.ready = false;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel.webview.html = this.html(this.panel.webview, media);
    }

    private post(msg: any): void {
        void this.panel?.webview.postMessage(msg);
    }

    private onMessage(m: any): void {
        const s = this.session;
        switch (m.type) {
            case 'ready':
                this.ready = true;
                this.post({ type: s ? 'attached' : 'detached' });
                if (s) this.post({ type: 'state', running: s.isRunning() });
                s?.input('screen', {});
                if (this.highlightRect) this.post({ type: 'highlight', rect: this.highlightRect });
                break;
            case 'key':
                s?.input('key', { scancode: m.scancode, down: m.down });
                break;
            case 'releaseKeys':
                s?.input('releaseKeys', {});
                break;
            case 'joy':
                s?.input('joy', { bits: m.bits });
                break;
            case 'mouse':
                s?.input('mouse', m.args);
                break;
            case 'togglePause':
                void s?.togglePause();
                break;
            case 'audio':
                s?.input('audio', { on: m.on });
                break;
            case 'showNextView':
                void vscode.commands.executeCommand('mbxNext.showNextView');
                break;
            case 'raster':
                void this.raster(m.seq);
                break;
        }
    }

    /** Poloha paprsku pro zastavený stroj (příkaz serveru `raster`); bez sezení / starý server → null. */
    private async raster(seq: unknown): Promise<void> {
        const s = this.session;
        let data: any = null;
        if (s && !s.isRunning()) {
            try {
                const { id: _id, ok: _ok, ...r } = await s.serverRequest('raster');
                data = r;
            } catch {
                data = null;
            }
        }
        this.post({ type: 'raster', seq, data });
    }

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'screen.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'screen.css'));
        return `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>ZX Spectrum Next</title>
</head>
<body>
<div id="bar">
  <button id="pause" title="${esc(t('screen.pauseTooltip'))}">⏸</button>
  <button id="sound" title="${esc(t('screen.soundTooltip'))}">🔇</button>
  <button id="beam" title="${esc(t('screen.beamTooltip'))}" aria-pressed="true"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M0 6.5h14" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v11" stroke="currentColor" stroke-width="2"/></svg></button>
  <span id="status">${esc(t('screen.waiting'))}</span>
  <span id="raster"></span>
  <button id="next" title="${esc(t('screen.nextTooltip'))}">Next</button>
</div>
<div id="wrap"><div id="frame">
  <canvas id="screen" width="640" height="256" tabindex="0"></canvas>
  <canvas id="overlay" width="640" height="256"></canvas>
</div></div>
<div id="hint">${esc(t('screen.hint'))}</div>
${dictionaryScript(nonce, 'screen.')}
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
