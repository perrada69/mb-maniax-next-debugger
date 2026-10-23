// Doplnění náhrady modulu vscode pro testy reloadu (ext-reload*.test.ts): tasks, ProgressLocation,
// TaskGroup a pár funkcí workspace. Musí se importovat PŘED moduly ze src/ – esbuild jim kopíruje
// vlastnosti nejvyšší úrovně modulu vscode při načtení, později přidané by neviděly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vs = require('vscode');

const noop = () => undefined;
const disposable = { dispose: noop };

/** Jednoduchá událost (posluchači, fire). */
export function emitter<T>() {
    const listeners = new Set<(v: T) => void>();
    return {
        event: (l: (v: T) => void) => {
            listeners.add(l);
            return { dispose: () => listeners.delete(l) };
        },
        fire: (v: T) => [...listeners].forEach((l) => l(v)),
        count: () => listeners.size,
    };
}

export const endTask = emitter<any>();
export const endTaskProcess = emitter<any>();
export const startSession = emitter<any>();
export const terminateSession = emitter<any>();
export const saveDocument = emitter<any>();

vs.tasks = {
    fetchTasks: async () => [],
    executeTask: async () => ({}),
    onDidEndTask: endTask.event,
    onDidEndTaskProcess: endTaskProcess.event,
};
vs.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
vs.QuickPickItemKind = { Separator: -1, Default: 0 };
vs.TaskGroup = { Build: { id: 'build', isDefault: undefined } };
vs.debug.onDidStartDebugSession = startSession.event;
vs.debug.onDidTerminateDebugSession = terminateSession.event;
vs.workspace.onDidSaveTextDocument = saveDocument.event;
vs.workspace.getWorkspaceFolder = () => ({ uri: { toString: () => 'file:///ws' }, name: 'ws', index: 0 });
vs.workspace.saveAll = async () => true;
vs.window.withProgress = (_o: any, task: () => any) => task();
vs.window.setStatusBarMessage = () => disposable;

export { vs };
