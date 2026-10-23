// Příkaz „Přeložit a nahrát znovu“ (bez ukončení ladění): úloha preLaunchTask z konfigurace sezení,
// a když se překlad povede, vlastní požadavek DAP `reload` (session.ts) – adaptér načte nové SLD,
// přepočítá breakpointy a nahraje program znovu; obrazovka i panel Next zůstávají otevřené.
// Volitelně po uložení zdrojáku (mbxNext.reloadOnSave).

import * as vscode from 'vscode';
import { t } from './i18n';

const TYPE = 'mbx-next';
/** Zdrojáky, jejichž uložení spustí reload (mbxNext.reloadOnSave). */
export const SOURCE_RE = /\.(asm|a80|z80|s|inc)$/i;
/** Uložení více souborů najednou (Uložit vše) = jeden reload. */
const SAVE_DELAY = 300;

/** preLaunchTask z launch.json: jméno úlohy, ${defaultBuildTask} nebo identifikátor {type, …}. */
export type TaskRef = string | { type: string; [key: string]: any };

function sameScope(task: vscode.Task, folder?: vscode.WorkspaceFolder): boolean {
    const s: any = task.scope;
    return !!folder && !!s && typeof s === 'object' && s.uri?.toString() === folder.uri.toString();
}

/**
 * Úloha podle preLaunchTask: jméno (`label` z tasks.json), „zdroj: jméno“ (zjištěné úlohy),
 * `${defaultBuildTask}`, nebo identifikátor (shoda všech jeho polí s `definition`). Víc shod →
 * přednost má úloha ze složky sezení.
 */
export function findTask(tasks: readonly vscode.Task[], ref: TaskRef, folder?: vscode.WorkspaceFolder): vscode.Task | undefined {
    let match: (task: vscode.Task) => boolean;
    if (typeof ref === 'string') {
        const name = ref.trim();
        if (name === '${defaultBuildTask}') {
            match = (task) => {
                const g: any = task.group;
                return !!g && g.isDefault === true && (g.id === 'build' || g === (vscode as any).TaskGroup?.Build);
            };
        } else match = (task) => task.name === name || `${task.source}: ${task.name}` === name;
    } else if (ref && typeof ref === 'object') {
        match = (task) => Object.entries(ref).every(([k, v]) => JSON.stringify((task.definition as any)?.[k]) === JSON.stringify(v));
    } else return undefined;
    const found = tasks.filter(match);
    return found.find((task) => sameScope(task, folder)) ?? found[0];
}

/** Jméno úlohy z preLaunchTask pro hlášky. */
function refName(ref: TaskRef): string {
    return typeof ref === 'string' ? ref : JSON.stringify(ref);
}

/** Spustí úlohu a počká na konec; výsledek = návratový kód procesu (undefined u úloh bez procesu). */
export async function runTask(task: vscode.Task): Promise<number | undefined> {
    // Posluchače už před spuštěním (krátká úloha může skončit dřív, než executeTask vrátí).
    const codes = new Map<vscode.TaskExecution, number | undefined>();
    const ended = new Set<vscode.TaskExecution>();
    let execution: vscode.TaskExecution | undefined;
    let done: ((code: number | undefined) => void) | undefined;
    const finish = (e: vscode.TaskExecution) => {
        if (execution && e === execution) done?.(codes.get(e));
    };
    const subs = [
        vscode.tasks.onDidEndTaskProcess((e) => codes.set(e.execution, e.exitCode)),
        vscode.tasks.onDidEndTask((e) => {
            ended.add(e.execution);
            finish(e.execution);
        }),
    ];
    try {
        const result = new Promise<number | undefined>((resolve) => (done = resolve));
        execution = await vscode.tasks.executeTask(task);
        if (ended.has(execution)) return codes.get(execution);
        return await result;
    } finally {
        for (const s of subs) s.dispose();
    }
}

type Phase = 'idle' | 'starting' | 'building' | 'loading';

export class ReloadController {
    private phase: Phase = 'idle';
    /** během překladu / nahrávání se uložil další zdroják → po dokončení ještě jednou */
    private again?: vscode.DebugSession;
    private saveTimer?: NodeJS.Timeout;
    /** běžící sezení mbx-next (aktivní sezení může být jiného typu) */
    private sessions: vscode.DebugSession[] = [];

    /** Příkaz a sledování uložení (registruje extension.ts). */
    register(): vscode.Disposable[] {
        return [
            vscode.commands.registerCommand('mbxNext.reload', () => this.reload()),
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === TYPE) this.sessions.push(s);
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                this.sessions = this.sessions.filter((x) => x !== s);
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
            { dispose: () => clearTimeout(this.saveTimer) },
        ];
    }

    /** Probíhá překlad nebo nahrávání? */
    isBusy(): boolean {
        return this.phase !== 'idle';
    }

    private session(): vscode.DebugSession | undefined {
        const active = vscode.debug.activeDebugSession;
        if (active?.type === TYPE) return active;
        return this.sessions[this.sessions.length - 1];
    }

    /** Uložený soubor: při mbxNext.reloadOnSave a běžícím ladění reload (zdroják z workspace). */
    onSave(doc: vscode.TextDocument): void {
        if (!vscode.workspace.getConfiguration('mbxNext').get<boolean>('reloadOnSave', false)) return;
        if (!SOURCE_RE.test(doc.fileName) || !vscode.workspace.getWorkspaceFolder(doc.uri)) return;
        const session = this.session();
        if (!session) return;
        // Uložení na začátku reloadu (sám ukládá rozpracované soubory) už v překladu bude.
        if (this.phase === 'starting') return;
        if (this.phase !== 'idle') {
            this.again = session;
            return;
        }
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.reload(session, true), SAVE_DELAY);
    }

    /**
     * Přeloží (preLaunchTask) a nahraje program znovu. Druhý požadavek během běžícího: z příkazu
     * hláška, z uložení souboru proběhne ještě jednou po dokončení. Výsledek: nahráno (true).
     */
    async reload(target?: vscode.DebugSession, fromSave = false): Promise<boolean> {
        const session = target ?? this.session();
        if (!session) {
            void vscode.window.showWarningMessage(t('reload.notDebugging'));
            return false;
        }
        if (this.phase !== 'idle') {
            if (fromSave) this.again = session;
            else void vscode.window.showInformationMessage(t('reload.busy'));
            return false;
        }
        let ok = false;
        try {
            let next: vscode.DebugSession | undefined = session;
            while (next) {
                this.again = undefined;
                ok = await this.once(next);
                next = this.again;
                if (next && !this.sessions.includes(next) && vscode.debug.activeDebugSession !== next) next = undefined;
            }
        } finally {
            this.phase = 'idle';
            this.again = undefined;
        }
        return ok;
    }

    private async once(session: vscode.DebugSession): Promise<boolean> {
        this.phase = 'starting';
        await Promise.resolve(vscode.workspace.saveAll?.(false)).catch(() => undefined);
        const ref = session.configuration?.preLaunchTask as TaskRef | undefined;
        if (ref) {
            const tasks = await vscode.tasks.fetchTasks();
            const task = findTask(tasks, ref, session.workspaceFolder);
            if (!task) {
                void vscode.window.showErrorMessage(t('reload.taskNotFound', refName(ref)));
                return false;
            }
            this.phase = 'building';
            let code: number | undefined;
            try {
                code = await this.progress(t('reload.building', task.name), () => runTask(task));
            } catch (e: any) {
                void vscode.window.showErrorMessage(t('reload.buildFailedError', task.name, e?.message ?? String(e)));
                return false;
            }
            if (code !== undefined && code !== 0) {
                void vscode.window.showErrorMessage(t('reload.buildFailed', task.name, code));
                return false;
            }
        }
        this.phase = 'loading';
        try {
            await this.progress(t('reload.loading'), () => Promise.resolve(session.customRequest('reload')));
        } catch (e: any) {
            void vscode.window.showErrorMessage(t('reload.failed', e?.message ?? String(e)));
            return false;
        }
        vscode.window.setStatusBarMessage?.(t('reload.done'), 3000);
        return true;
    }

    private progress<T>(title: string, task: () => Promise<T>): Promise<T> {
        const w: any = vscode.window;
        if (typeof w.withProgress !== 'function') return task();
        return Promise.resolve(w.withProgress({ location: (vscode as any).ProgressLocation?.Window ?? 10, title }, task));
    }
}
