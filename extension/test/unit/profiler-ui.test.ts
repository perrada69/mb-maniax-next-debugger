// Profiler ve VS Code (src/profiler.ts ProfilerController): po zastavení nabídne výsledky
// a ve stavovém řádku nechá součet posledního měření, dokud se nevynuluje.
import { vs } from './ext-vscode-setup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { setLanguage, t } from '../../src/i18n';
import { ProfilerController } from '../../src/profiler';

/** Stavový řádek, příkazy, hlášky a výběr – co uživatel uvidí. */
function ui() {
    const status: any = { visible: false, text: '', tooltip: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    const commands: Record<string, () => Promise<void>> = {};
    const shown = { info: [] as string[][], picks: [] as any[] };
    let answer: string | undefined;
    vs.window.createStatusBarItem = () => status;
    vs.commands.registerCommand = (id: string, f: () => Promise<void>) => ((commands[id] = f), vs.disposable);
    vs.commands.executeCommand = async () => undefined;
    vs.window.showInformationMessage = async (msg: string, ...buttons: string[]) => (shown.info.push([msg, ...buttons]), answer);
    vs.window.showQuickPick = async (items: any[]) => (shown.picks.push(items), undefined);
    vs.window.setStatusBarMessage = () => vs.disposable;
    vs.window.showWarningMessage = async () => undefined;
    return { status, commands, shown, answer: (a: string | undefined) => (answer = a) };
}

/** Sezení s podvrženým serverem: profiler měří, po stop data zahodí. */
function session() {
    let active = false;
    const data = { active: true, total: 1500, count: 2, entries: [{ page: 4, offset: 0, pc: 0x8000, t: 1000 }, { page: 4, offset: 3, pc: 0x8003, t: 500 }] };
    return {
        isRunning: () => false,
        getSld: () => undefined,
        serverRequest: async (cmd: string) => {
            if (cmd === 'profilerStart') return (active = true), { active };
            if (cmd === 'profilerStop') return (active = false), {};
            if (cmd === 'profilerClear') return {};
            if (cmd === 'profilerData') return active ? data : { active: false, total: 0, count: 0, entries: [] };
            throw new Error(cmd);
        },
    };
}

test('po zastavení: hláška se součtem a tlačítkem Zobrazit výsledky, které otevře seznam funkcí', async () => {
    setLanguage('en');
    const u = ui();
    const p = new ProfilerController();
    p.register();
    p.attach(session() as any);
    await u.commands['mbxNext.profilerStart']();
    assert.equal(u.status.visible, true);
    u.answer(t('profiler.showResultsButton'));
    await u.commands['mbxNext.profilerStop']();
    assert.deepEqual(u.shown.info[0], [t('profiler.stoppedResults', '1,500'), t('profiler.showResultsButton')]);
    assert.equal(u.shown.picks.length, 1, 'tlačítko otevřelo seznam nejdražších funkcí');
    // stavový řádek zůstal se součtem posledního měření a klik ukáže výsledky
    assert.equal(u.status.visible, true);
    assert.match(u.status.text, /1,500 T/);
    assert.equal(u.status.tooltip, t('profiler.statusStoppedTooltip'));
    // výsledky jdou zobrazit i po zastavení (data ze serveru už jsou pryč)
    await u.commands['mbxNext.profilerShow']();
    assert.equal(u.shown.picks.length, 2);
    // Vynulovat stavový řádek schová
    await u.commands['mbxNext.profilerClear']();
    assert.equal(u.status.visible, false);
});

test('zastavení bez naměřených dat: žádná hláška s tlačítkem, stavový řádek schovaný', async () => {
    setLanguage('en');
    const u = ui();
    const p = new ProfilerController();
    p.register();
    const s = session();
    s.serverRequest = async (cmd: string) => (cmd === 'profilerData' ? { active: true, total: 0, count: 0, entries: [] } : {});
    p.attach(s as any);
    await u.commands['mbxNext.profilerStart']();
    await u.commands['mbxNext.profilerStop']();
    assert.equal(u.shown.info.length, 0);
    assert.equal(u.status.visible, false);
});
