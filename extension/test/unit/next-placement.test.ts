// Panel Next nesmí překrýt obrazovku emulátoru: je-li otevřená, otevře se do nové skupiny pod ní
// (src/nextview.ts show, src/screen.ts focusGroup).
import { vs } from './ext-vscode-setup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NextViewPanel } from '../../src/nextview';
import { ScreenPanel } from '../../src/screen';

/** Zaznamená příkazy a sloupce nově vytvořených webview panelů. */
function record() {
    const log: string[] = [];
    vs.commands.executeCommand = async (cmd: string) => void log.push('cmd ' + cmd);
    vs.window.createWebviewPanel = (_type: string, title: string, show: any) => {
        log.push(`panel ${title} ${typeof show === 'object' ? show.viewColumn : show}`);
        return {
            webview: { html: '', onDidReceiveMessage: () => vs.disposable, postMessage: async () => true, asWebviewUri: (u: any) => u, cspSource: 'x' },
            onDidDispose: () => vs.disposable,
            reveal: (col: any) => log.push('reveal ' + col),
            viewColumn: 2,
        };
    };
    return log;
}

test('bez obrazovky: panel Next vedle editoru (Beside), žádná nová skupina', async () => {
    const log = record();
    const next = new NextViewPanel(vs.Uri.file('/ext'), () => undefined, () => false);
    await next.show();
    assert.deepEqual(log, [`panel Next ${vs.ViewColumn.Beside}`]);
});

test('s otevřenou obrazovkou: aktivovat její skupinu, nová skupina pod ní, panel Next do ní', async () => {
    const log = record();
    const screen = new ScreenPanel(vs.Uri.file('/ext'));
    assert.equal(screen.focusGroup(), false, 'zavřená obrazovka: nic');
    screen.show(true);
    log.length = 0;
    const next = new NextViewPanel(vs.Uri.file('/ext'), () => undefined, () => screen.focusGroup());
    await next.show();
    assert.deepEqual(log, ['reveal 2', 'cmd workbench.action.newGroupBelow', `panel Next ${vs.ViewColumn.Active}`]);
    // podruhé jen ukázat existující panel
    log.length = 0;
    await next.show();
    assert.deepEqual(log, ['reveal undefined']);
});
