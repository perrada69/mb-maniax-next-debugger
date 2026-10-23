// Náhrada modulu vscode pro testy mimo VS Code: jen to, co moduly rozšíření potřebují při načtení.
// Testy si chování dál upravují (např. window.showInputBox) přímo na tomto objektu.
const noop = () => undefined;
const disposable = { dispose: noop };
class EventEmitter {
    constructor() { this.listeners = []; this.event = (l) => (this.listeners.push(l), disposable); }
    fire(v) { for (const l of this.listeners) l(v); }
    dispose() {}
}
class ThemeColor { constructor(id) { this.id = id; } }
class Range { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } }
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Uri { constructor(p) { this.fsPath = p; this.path = p; } static file(p) { return new Uri(p); } static joinPath(u, ...s) { return new Uri([u.fsPath, ...s].join('/')); } }
module.exports = {
    EventEmitter, ThemeColor, Range, Position, Uri, disposable,
    window: {
        createTextEditorDecorationType: () => ({ dispose: noop }),
        createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
        createOutputChannel: () => ({ appendLine: noop, show: noop, clear: noop, dispose: noop }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showInputBox: async () => undefined,
        showQuickPick: async () => undefined,
        visibleTextEditors: [],
        onDidChangeVisibleTextEditors: () => disposable,
        onDidChangeActiveTextEditor: () => disposable,
    },
    workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => disposable },
    commands: { registerCommand: () => disposable, executeCommand: async () => undefined },
    debug: { activeDebugSession: undefined, onDidStartDebugSession: () => disposable, onDidTerminateDebugSession: () => disposable },
    env: { language: 'en' },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    ViewColumn: { Beside: -2, Active: -1 },
};
