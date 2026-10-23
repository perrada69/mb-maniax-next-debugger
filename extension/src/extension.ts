// MB Maniax Next Debugger – rozšíření VS Code: ladicí sezení (session.ts) běží přímo v rozšíření,
// aby mohlo posílat obraz a zvuk do panelu s obrazovkou (screen.ts) a data do panelu Next (nextview.ts).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { setLanguage, t } from './i18n';
import { openManual } from './manual';
import { NextViewPanel } from './nextview';
import { ProfilerController } from './profiler';
import { ReloadController } from './reload';
import { ScreenPanel } from './screen';
import { NextDebugSession } from './session';
import { StatesController } from './states';

const TYPE = 'mbx-next';

/** Ladicí server: z nastavení, přibalený k rozšíření, nebo z repozitáře při vývoji. */
function serverPath(context: vscode.ExtensionContext): string {
    const configured = vscode.workspace.getConfiguration('mbxNext').get<string>('serverPath');
    if (configured) return configured;
    const exe = process.platform === 'win32' ? 'mbx-next-server.exe' : 'mbx-next-server';
    const candidates = [
        path.join(context.extensionPath, 'bin', `${process.platform}-${process.arch}`, exe),
        path.join(context.extensionPath, '..', 'build', 'release', 'bin', exe),
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

/** Jazyk textů podle nastavení mbxNext.language (auto = jazyk VS Code / systému). */
function applyLanguage(): void {
    setLanguage(vscode.workspace.getConfiguration('mbxNext').get<string>('language', 'auto'), vscode.env.language);
}

export function activate(context: vscode.ExtensionContext): void {
    applyLanguage();
    const screen = new ScreenPanel(context.extensionUri);
    const next = new NextViewPanel(context.extensionUri, (rect) => screen.highlight(rect), () => screen.focusGroup());
    const states = new StatesController();
    const profiler = new ProfilerController();
    const reload = new ReloadController();

    context.subscriptions.push(
        ...states.register(),
        ...profiler.register(),
        ...reload.register(),
        vscode.debug.registerDebugAdapterDescriptorFactory(TYPE, {
            createDebugAdapterDescriptor() {
                return new vscode.DebugAdapterInlineImplementation(new NextDebugSession(serverPath(context), screen, [next, states, profiler]));
            },
        }),
        vscode.debug.registerDebugConfigurationProvider(TYPE, {
            resolveDebugConfiguration(folder, config) {
                // F5 bez launch.json: program podle otevřeného .asm (stejné jméno, .nex a .sld).
                if (!config.type && !config.request && !config.name) {
                    const doc = vscode.window.activeTextEditor?.document;
                    if (!doc || !/\.(asm|a80|z80|s)$/i.test(doc.fileName)) return config;
                    const base = doc.fileName.replace(/\.[^.]+$/, '');
                    return {
                        type: TYPE,
                        request: 'launch',
                        name: t('extension.launchName'),
                        program: base + '.nex',
                        sld: base + '.sld',
                    };
                }
                return config;
            },
        }),
        vscode.commands.registerCommand('mbxNext.showScreen', () => screen.show()),
        vscode.commands.registerCommand('mbxNext.showNextView', () => next.show()),
        vscode.commands.registerCommand('mbxNext.openManual', () => openManual(context.extensionPath)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('mbxNext.language')) return;
            // Nový jazyk: otevřené panely se postaví znovu (po "ready" dostanou zpět stav sezení).
            applyLanguage();
            screen.rebuild();
            next.rebuild();
        }),
    );
}

export function deactivate(): void {}
