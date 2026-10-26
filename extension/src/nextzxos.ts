// NextZXOS pro start do NextZXOS (launch "boot": "nextzxos"): oficiální distribuce ze specnext.com,
// stažená až na pokyn uživatele a po souhlasu s licencí, uložená jen v datech rozšíření
// (globalStorage), nikdy v projektu ani v balíčku rozšíření. Z ní pracovní karta, společná všem
// projektům (každý program má na kartě svou složku /MBX/<jméno>), kterou jde vrátit do stavu po
// stažení nebo z ní smazat /MBX.
//
//   nextzxos/<jméno zipu>   stažený zip (ověřená velikost a SHA-256)
//   nextzxos/base.img       karta připravená ze zipu (FAT32 pro JNEXT), nemění se
//   nextzxos/card.img       pracovní karta, kterou bootuje emulátor

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from './i18n';
import { ServerConnection } from './server';

/** Text licence distribuce (The Next License) z oficiálního repozitáře distribuce. */
export const LICENSE_URL = 'https://gitlab.com/thesmog358/tbblue/-/raw/master/LICENSE.md';
const CONSENT_KEY = 'mbxNext.nextzxosLicense';

export interface DistroSettings {
    url: string;
    sha256: string;
    size: number;
}

/** Nastavení mbxNext.nextzxos.* (výchozí: System/Next 24.11 pro emulátory, ověřený otisk). */
export function distroSettings(): DistroSettings {
    const c = vscode.workspace.getConfiguration('mbxNext.nextzxos');
    return {
        url: c.get<string>('url', 'https://www.specnext.com/distro/24.11/sn-emulator-24.11.zip'),
        sha256: c.get<string>('sha256', 'b2b0cbfb421acba2dcd00b081e647d7ead7bd0bc35952f0fdcafe1581321b516').toLowerCase(),
        size: c.get<number>('size', 51829771),
    };
}

/** HTTPS GET s přesměrováním; `onData` dostává kusy, `onTotal` délku (0 = neznámá). */
export function httpGet(
    url: string,
    onData: (chunk: Buffer) => void,
    onTotal: (total: number) => void,
    token?: vscode.CancellationToken,
    redirects = 5,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'mbx-next-debugger' } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
                res.resume();
                httpGet(new URL(res.headers.location, url).toString(), onData, onTotal, token, redirects - 1).then(resolve, reject);
                return;
            }
            if (code !== 200) {
                res.resume();
                reject(new Error(`HTTP ${code}`));
                return;
            }
            onTotal(Number(res.headers['content-length'] ?? 0));
            res.on('data', (d: Buffer) => onData(d));
            res.on('end', () => resolve());
            res.on('error', reject);
        });
        req.on('error', reject);
        token?.onCancellationRequested(() => req.destroy(new Error('cancelled')));
    });
}

export class NextZxos {
    readonly dir: string;
    /** Sezení, která právě bootují z pracovní karty (karta se tehdy neobnovuje ani nečistí). */
    readonly busy = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly serverPath: () => string,
    ) {
        this.dir = path.join(context.globalStorageUri.fsPath, 'nextzxos');
    }

    get base(): string {
        return path.join(this.dir, 'base.img');
    }
    get card(): string {
        return path.join(this.dir, 'card.img');
    }
    zipPath(s = distroSettings()): string {
        return path.join(this.dir, path.basename(new URL(s.url).pathname) || 'distro.zip');
    }

    /** Pracovní karta pro launch; chybí-li distribuce, nabídne stažení. undefined = zrušeno. */
    async ensureCard(): Promise<string | undefined> {
        if (fs.existsSync(this.card)) return this.card;
        if (fs.existsSync(this.base)) {
            await fs.promises.copyFile(this.base, this.card);
            return this.card;
        }
        const download = t('nextzxos.download');
        const pick = await vscode.window.showInformationMessage(t('nextzxos.needDistro'), { modal: true }, download);
        if (pick !== download) return undefined;
        return (await this.download()) ? this.card : undefined;
    }

    /** Příkaz „Stáhnout NextZXOS“: licence, stažení, kontrola, příprava karty. */
    async download(): Promise<boolean> {
        const s = distroSettings();
        if (!(await this.consent())) return false;
        await fs.promises.mkdir(this.dir, { recursive: true });
        const zip = this.zipPath(s);
        try {
            if (!(await this.zipOk(zip, s))) await this.fetchZip(zip, s);
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t('nextzxos.preparing') },
                () => this.prepare(zip),
            );
            await fs.promises.copyFile(this.base, this.card);
        } catch (e: any) {
            if (e?.message !== 'cancelled') vscode.window.showErrorMessage(t('nextzxos.downloadFailed', e?.message ?? String(e)));
            return false;
        }
        vscode.window.showInformationMessage(t('nextzxos.ready', this.dir));
        return true;
    }

    /** Souhlas s licencí distribuce: text z oficiálního repozitáře, uloží se otisk souhlaseného textu. */
    private async consent(): Promise<boolean> {
        let text = '';
        try {
            const parts: Buffer[] = [];
            await httpGet(LICENSE_URL, (d) => parts.push(d), () => undefined);
            text = Buffer.concat(parts).toString('utf8');
        } catch (e: any) {
            vscode.window.showErrorMessage(t('nextzxos.licenseFetchFailed', LICENSE_URL, e?.message ?? String(e)));
            return false;
        }
        const digest = crypto.createHash('sha256').update(text).digest('hex');
        if (this.context.globalState.get<string>(CONSENT_KEY) === digest) return true;
        const agreed = await showLicense(text);
        if (agreed) await this.context.globalState.update(CONSENT_KEY, digest);
        return agreed;
    }

    private async zipOk(zip: string, s: DistroSettings): Promise<boolean> {
        try {
            if ((await fs.promises.stat(zip)).size !== s.size) return false;
            return (await sha256File(zip)) === s.sha256;
        } catch {
            return false;
        }
    }

    private fetchZip(zip: string, s: DistroSettings): Promise<void> {
        const part = zip + '.part';
        return Promise.resolve(
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t('nextzxos.downloading', s.url), cancellable: true },
                async (progress, token) => {
                    const out = fs.createWriteStream(part);
                    const hash = crypto.createHash('sha256');
                    let got = 0;
                    let total = s.size;
                    let shown = 0;
                    try {
                        await httpGet(
                            s.url,
                            (d) => {
                                out.write(d);
                                hash.update(d);
                                got += d.length;
                                const pct = Math.floor((got * 100) / Math.max(1, total));
                                if (pct > shown) {
                                    progress.report({ increment: pct - shown, message: `${Math.round(got / 1048576)} / ${Math.round(total / 1048576)} MB` });
                                    shown = pct;
                                }
                            },
                            (n) => (total = n || total),
                            token,
                        );
                    } finally {
                        await new Promise((r) => out.end(r));
                    }
                    const digest = hash.digest('hex');
                    if (got !== s.size || digest !== s.sha256) {
                        await fs.promises.rm(part, { force: true });
                        throw new Error(t('nextzxos.badDownload', got, digest));
                    }
                    await fs.promises.rename(part, zip);
                },
            ),
        );
    }

    /** Karta ze zipu: vybalení a úprava obrazu dělá ladicí server (jádro JNEXT). */
    private async prepare(zip: string): Promise<void> {
        const server = new ServerConnection(this.serverPath(), this.dir);
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(t('session.serverNoResponse'))), 10000);
                server.on('event', (e) => {
                    if (e.event === 'ready') {
                        clearTimeout(timer);
                        resolve();
                    }
                });
                server.once('exit', () => reject(new Error(t('session.serverExitedOnStart'))));
            });
            await server.request('prepareSd', { zip, sdImage: this.base });
        } finally {
            server.close();
        }
    }

    /** Příkaz „Obnovit pracovní kartu“ (a po sezení podle nastavení): karta znovu ze stavu po stažení. */
    async resetCard(quiet = false): Promise<void> {
        if (!fs.existsSync(this.base)) {
            if (!quiet) vscode.window.showWarningMessage(t('nextzxos.noDistro'));
            return;
        }
        if (this.busy.size) {
            if (!quiet) vscode.window.showWarningMessage(t('nextzxos.cardBusy'));
            return;
        }
        // Server po sezení ještě chvíli drží soubor otevřený: pár pokusů.
        for (let i = 0; ; ++i) {
            try {
                await fs.promises.copyFile(this.base, this.card);
                break;
            } catch (e) {
                if (i >= 20) throw e;
                await new Promise((r) => setTimeout(r, 250));
            }
        }
        if (!quiet) vscode.window.showInformationMessage(t('nextzxos.cardReset'));
    }

    /** Příkaz „Vyčistit pracovní kartu“: smaže /MBX (složky programů) na pracovní kartě. */
    async cleanCard(): Promise<void> {
        if (!fs.existsSync(this.card)) {
            vscode.window.showWarningMessage(t('nextzxos.noDistro'));
            return;
        }
        if (this.busy.size) {
            vscode.window.showWarningMessage(t('nextzxos.cardBusy'));
            return;
        }
        const server = new ServerConnection(this.serverPath(), this.dir);
        try {
            await new Promise<void>((resolve) => server.on('event', (e) => e.event === 'ready' && resolve()));
            await server.request('cleanCard', { sdImage: this.card, folder: '/MBX' });
            vscode.window.showInformationMessage(t('nextzxos.cardCleaned'));
        } catch (e: any) {
            vscode.window.showErrorMessage(e?.message ?? String(e));
        } finally {
            server.close();
        }
    }
}

export async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Licence ve webview s tlačítky Souhlasím / Zrušit. */
function showLicense(text: string): Promise<boolean> {
    const panel = vscode.window.createWebviewPanel('mbxNext.nextzxosLicense', t('nextzxos.licenseTitle'), vscode.ViewColumn.Active, { enableScripts: true });
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);padding:0 16px 16px}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}
button{margin-right:8px;padding:6px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}</style></head><body>
<h2>${escapeHtml(t('nextzxos.licenseTitle'))}</h2>
<p>${escapeHtml(t('nextzxos.licenseIntro'))}</p>
<p>${escapeHtml(t('nextzxos.amstrad'))}</p>
<p><button id="yes">${escapeHtml(t('nextzxos.licenseAgree'))}</button><button id="no" class="secondary">${escapeHtml(t('nextzxos.licenseDecline'))}</button></p>
<pre>${escapeHtml(text)}</pre>
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.getElementById('yes').onclick=()=>vs.postMessage(true);document.getElementById('no').onclick=()=>vs.postMessage(false);</script>
</body></html>`;
    return new Promise((resolve) => {
        let done = false;
        panel.webview.onDidReceiveMessage((m) => {
            done = true;
            resolve(m === true);
            panel.dispose();
        });
        panel.onDidDispose(() => {
            if (!done) resolve(false);
        });
    });
}
