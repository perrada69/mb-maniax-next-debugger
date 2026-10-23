// Uložené stavy emulátoru: pojmenované stavy v paměti serveru (nejvýš 8 na sezení) a export /
// import do souboru .mbxstate. Server ukládá jen na hranici snímku (běžící stroj na ní je vždy);
// stojí-li v pauze uprostřed snímku ("notAtFrameBoundary"), nabídne se doběhnout na konec snímku
// a uložit (`advance: true`). Po obnovení server sám
// pošle stopped a adaptér obnoví UI.

import * as vscode from 'vscode';
import { language, t } from './i18n';
import { NextDebugSession, SessionListener } from './session';

const EXT = 'mbxstate';

/** Chyba serveru s daným kódem (server posílá anglické kódy v `error`). */
function isCode(e: any, code: string): boolean {
    return String(e?.message ?? e).includes(code);
}

export class StatesController implements SessionListener {
    private session?: NextDebugSession;

    attach(session: NextDebugSession): void {
        this.session = session;
    }

    detach(session: NextDebugSession): void {
        if (this.session === session) this.session = undefined;
    }

    state(_running: boolean): void {}

    /** Příkazy uložených stavů (registruje extension.ts). */
    register(): vscode.Disposable[] {
        return [
            vscode.commands.registerCommand('mbxNext.saveState', () => this.save()),
            vscode.commands.registerCommand('mbxNext.restoreState', () => this.restore()),
            vscode.commands.registerCommand('mbxNext.exportState', () => this.exportFile()),
            vscode.commands.registerCommand('mbxNext.importState', () => this.importFile()),
        ];
    }

    private requireSession(): NextDebugSession | undefined {
        if (!this.session) void vscode.window.showWarningMessage(t('states.notDebugging'));
        return this.session;
    }

    /**
     * Příkaz, který server umí jen na hranici snímku: při "notAtFrameBoundary" se zeptá, zda doběhnout
     * na konec snímku, a zopakuje ho s `advance: true`. Zrušení → undefined.
     */
    private async atFrameBoundary(s: NextDebugSession, cmd: string, args: Record<string, any>): Promise<any> {
        try {
            return await s.serverRequest(cmd, args);
        } catch (e) {
            if (!isCode(e, 'notAtFrameBoundary')) throw e;
        }
        const run = t('states.runAndSave');
        const answer = await vscode.window.showInformationMessage(t('states.notAtFrameBoundary'), { modal: true, detail: t('states.notAtFrameBoundaryDetail') }, run);
        if (answer !== run) return undefined;
        return s.serverRequest(cmd, { ...args, advance: true });
    }

    private async names(s: NextDebugSession): Promise<string[]> {
        const r = await s.serverRequest('stateList');
        return Array.isArray(r?.names) ? r.names.map(String) : [];
    }

    private async save(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        try {
            const existing = await this.names(s).catch(() => [] as string[]);
            const name = await vscode.window.showInputBox({
                title: t('states.saveTitle'),
                prompt: t('states.namePrompt'),
                value: new Date().toLocaleTimeString(language()),
                validateInput: (v) => (v.trim() ? undefined : t('states.nameEmpty')),
            });
            if (name === undefined) return;
            const n = name.trim();
            if (existing.includes(n)) {
                const overwrite = t('states.overwriteButton');
                if ((await vscode.window.showWarningMessage(t('states.overwrite', n), { modal: true }, overwrite)) !== overwrite) return;
            }
            const r = await this.atFrameBoundary(s, 'stateSave', { name: n });
            if (r === undefined) return;
            vscode.window.setStatusBarMessage(t('states.saved', n), 4000);
        } catch (e: any) {
            if (isCode(e, 'limit')) void vscode.window.showWarningMessage(t('states.limit', 8));
            else this.error(e);
        }
    }

    private async restore(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        try {
            const names = await this.names(s);
            if (!names.length) {
                void vscode.window.showInformationMessage(t('states.noStates'));
                return;
            }
            const name = await vscode.window.showQuickPick(names.slice().reverse(), {
                title: t('states.restoreTitle'),
                placeHolder: t('states.pickPlaceholder'),
            });
            if (name === undefined) return;
            try {
                await s.serverRequest('stateRestore', { name });
            } catch (e) {
                if (!isCode(e, 'notFound')) throw e;
                void vscode.window.showWarningMessage(t('states.notFound', name));
                return;
            }
            vscode.window.setStatusBarMessage(t('states.restored', name), 4000);
        } catch (e: any) {
            this.error(e);
        }
    }

    private defaultUri(): vscode.Uri | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) return undefined;
        const d = new Date();
        const p = (v: number) => String(v).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
        return vscode.Uri.joinPath(folder, `state_${stamp}.${EXT}`);
    }

    private async exportFile(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        try {
            const uri = await vscode.window.showSaveDialog({
                title: t('states.exportTitle'),
                defaultUri: this.defaultUri(),
                filters: { [t('states.fileFilter')]: [EXT] },
            });
            if (!uri) return;
            const r = await this.atFrameBoundary(s, 'stateExport', {});
            if (r === undefined) return;
            await vscode.workspace.fs.writeFile(uri, Buffer.from(String(r.data ?? ''), 'base64'));
            void vscode.window.showInformationMessage(t('states.exported', uri.fsPath));
        } catch (e: any) {
            this.error(e);
        }
    }

    private async importFile(): Promise<void> {
        const s = this.requireSession();
        if (!s) return;
        try {
            const uris = await vscode.window.showOpenDialog({
                title: t('states.importTitle'),
                canSelectMany: false,
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                filters: { [t('states.fileFilter')]: [EXT], [t('states.allFiles')]: ['*'] },
            });
            const uri = uris?.[0];
            if (!uri) return;
            const data = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64');
            await s.serverRequest('stateImport', { data });
            vscode.window.setStatusBarMessage(t('states.imported', uri.fsPath), 4000);
        } catch (e: any) {
            if (isCode(e, 'incompatible')) void vscode.window.showErrorMessage(t('states.incompatible'));
            else void vscode.window.showErrorMessage(t('states.importFailed', e?.message || String(e)));
        }
    }

    private error(e: any): void {
        void vscode.window.showErrorMessage(t('states.failed', e?.message || String(e)));
    }
}
