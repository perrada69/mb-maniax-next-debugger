// Panel Next – hostitel (src/nextview.ts): dotaz `symbols` ze SLD bez serveru, nové povolené
// dotazy serveru a obnova paměti ve VS Code po `writeMemory`.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { setLanguage } from '../../src/i18n';
import { ALLOWED, NextViewPanel, symbolsFor } from '../../src/nextview';
import { SldInfo } from '../../src/sld';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-symbols-'));

/** Umělé SLD: dva soubory, stránky 4, 5 a 10, řádek se dvěma instrukcemi, kód bez DEVICE. */
function artificialSld(): SldInfo {
    const lines = [
        '|SLD.data.version|1',
        'a.asm|1||0|4|32768|F|start',
        'a.asm|1||0|4|32768|L|,start,',
        'a.asm|2||0|4|32768|T|',
        'a.asm|3||0|4|32769|T|',
        'a.asm|3||0|4|32770|T|',          // dvě instrukce na řádku (makro) = jeden řádek
        'a.asm|4||0|5|40960|F|data_table',
        'a.asm|5||0|5|40960|T|',
        'b.asm|1||0|10|49152|F|bank_code',
        'b.asm|2||0|10|49152|T|',
        'b.asm|3||0|10|49155|T|',
        'b.asm|4||0|10|49158|T|',
        'c.asm|1||0|-1|24576|F|nodevice',
        'c.asm|2||0|-1|24576|T|',
    ];
    const p = path.join(dir, 'art.sld');
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return SldInfo.load(p);
}

test('symbolsFor: návěští se stránkou a počty řádků kódu ve stránkách', () => {
    const r = symbolsFor(artificialSld());
    assert.deepEqual(r.labels, [
        { name: 'start', addr: 0x8000, page: 4 },
        { name: 'data_table', addr: 0xa000, page: 5 },
        { name: 'bank_code', addr: 0xc000, page: 10 },
        { name: 'nodevice', addr: 0x6000, page: -1 },
    ]);
    assert.deepEqual(r.codePages, { '4': 2, '5': 1, '10': 3 });
    // JSON pro webview: klíče stránek jako text
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(r)).codePages), ['4', '5', '10']);
});

test('symbolsFor: bez SLD prázdné', () => {
    assert.deepEqual(symbolsFor(undefined), { labels: [], codePages: {} });
});

test('povolené dotazy pohledů: raster, soundState, pageUsage, writeMemory', () => {
    for (const c of ['raster', 'soundState', 'pageUsage', 'writeMemory', 'sprites', 'readMemory']) assert.ok(ALLOWED.has(c), c);
    assert.ok(!ALLOWED.has('launch'));
    assert.ok(!ALLOWED.has('setRegister'));
});

/** Panel s podvrženým webview a sezením; vrátí odeslané zprávy a volání sezení. */
function panelWith(session: any) {
    const panel = new NextViewPanel((vscode as any).Uri.file('/ext'), () => undefined);
    const posted: any[] = [];
    (panel as any).panel = { webview: { postMessage: async (m: any) => void posted.push(m) } };
    if (session) (panel as any).session = session;
    const ask = async (id: number, cmd: string, args?: any) => {
        (panel as any).onMessage({ type: 'request', id, cmd, args });
        await new Promise((r) => setTimeout(r, 1));
        return posted.filter((m) => m.type === 'response' && m.id === id).at(-1);
    };
    return { posted, ask };
}

test('NextViewPanel: symbols vyřídí rozšíření samo, bez serveru', async () => {
    setLanguage('en');
    const asked: string[] = [];
    const sld = artificialSld();
    const { ask } = panelWith({ getSld: () => sld, serverRequest: async (c: string) => void asked.push(c), memoryChanged: () => undefined });
    const r = await ask(1, 'symbols');
    assert.equal(r.ok, true);
    assert.equal(r.result.labels.length, 4);
    assert.equal(r.result.codePages['10'], 3);
    assert.deepEqual(asked, []);
    // bez SLD prázdné
    const empty = panelWith({ getSld: () => undefined, serverRequest: async () => ({}) });
    assert.deepEqual((await empty.ask(2, 'symbols')).result, { labels: [], codePages: {} });
    // bez sezení chyba
    const none = panelWith(undefined);
    assert.equal((await none.ask(3, 'symbols')).ok, false);
});

test('NextViewPanel: writeMemory jde na server a ohlásí změnu paměti', async () => {
    const changes: any[] = [];
    const asked: any[] = [];
    const { ask } = panelWith({
        getSld: () => undefined,
        serverRequest: async (cmd: string, args: any) => {
            asked.push([cmd, args]);
            if (cmd === 'writeMemory' && args.addr === 0xffff) throw new Error('bad address');
            return { id: 9, ok: true, written: 2 };
        },
        memoryChanged: (...a: any[]) => changes.push(a),
    });
    const r = await ask(1, 'writeMemory', { addr: 0x8000, data: Buffer.from([1, 2]).toString('base64') });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { written: 2 });
    assert.deepEqual(changes, [[0x8000, 2, undefined]]);
    await ask(2, 'writeMemory', { page: 10, addr: 0x10, data: 'AQ==' });
    assert.deepEqual(changes[1], [0x10, 2, 10]);
    // chyba serveru: žádná změna
    const bad = await ask(3, 'writeMemory', { addr: 0xffff, data: 'AQ==' });
    assert.equal(bad.ok, false);
    assert.equal(changes.length, 2);
    // čtecí dotaz změnu nehlásí
    await ask(4, 'raster');
    assert.equal(changes.length, 2);
    assert.deepEqual(asked.at(-1), ['raster', {}]);
    // nepovolený příkaz se k serveru nedostane
    const no = await ask(5, 'launch', { program: 'x' });
    assert.equal(no.ok, false);
    assert.ok(!asked.some((a) => a[0] === 'launch'));
});
