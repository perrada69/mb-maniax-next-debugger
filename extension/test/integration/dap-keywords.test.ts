// Integrační test klíčových slov v komentářích (WPMEM, LOGPOINT, ASSERTION) a instrukcí BREAK
// (FD 00 ze sjasmplus --zxnext=cspect i DD 01 z CSpectu – magic breakpoint jádra, stojí se ZA
// instrukcí): test/fixtures/keywords.asm (předpřeložený) a examples/features.
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { t } from '../../src/i18n';
import { DapClient, FIXTURES, lineOf, NO_SERVER, program, REPO, sleep } from './dap-client';

const kw = program('keywords', FIXTURES);
const L = (text: string) => lineOf(kw.source, text);
const hex4 = (v: number) => '$' + v.toString(16).toUpperCase().padStart(4, '0');
const opts = { skip: NO_SERVER, timeout: 30000 };

describe('klíčová slova a BREAK: test/fixtures/keywords.asm', { skip: NO_SERVER, timeout: 120000 }, () => {
    let c: DapClient;
    let launchEvents = 0;
    const label = (n: string) => c.session.getSld()!.label(n)!.addr;
    before(async () => {
        c = new DapClient('en');
        await c.launch({ program: kw.program, sld: kw.sld });
        launchEvents = c.events.length;
    });
    after(async () => {
        await c?.close();
    });

    test('varování ke chybným klíčovým slovům při spuštění (jednou, s místem ve zdrojáku)', opts, () => {
        const warn = c.outputs(0, 'important').slice(0, launchEvents).map((e) => e.body.output as string);
        const bad = L('LOGPOINT bad');
        const place = (line: number) => `keywords.asm:${line}`;
        const unknownName = warn.filter((w) => w.startsWith(t('session.keywordError', 'LOGPOINT', place(bad), '')) && w.includes('nosuchlabel'));
        assert.equal(unknownName.length, 1, warn.join(''));
        assert.ok(warn.includes(t('session.keywordError', 'LOGPOINT', place(bad), t('session.keywordBadFormat', 'weird')) + '\n'), warn.join(''));
        const access = lineOf(kw.source, 'WPMEM rtarget, 1, x');
        assert.ok(warn.includes(t('session.keywordError', 'WPMEM', place(access), t('session.keywordBadAccess', 'x')) + '\n'), warn.join(''));
        assert.equal(warn.length, 3, warn.join(''));
    });

    test('LOGPOINT s formáty a místem ve zdrojáku, pak ASSERTION A != 3', opts, async () => {
        const from = c.events.length;
        const s = await c.cont();
        assert.equal(s.body.reason, t('session.stopAssertion'));
        assert.equal(s.body.description, t('session.assertionFailed', 'A != 3'));
        assert.equal(await c.evaluate('A'), '$03 (3)');
        assert.equal((await c.top()).line, L('cp 5'));
        const logs = c.outputs(from, 'console').filter((e) => e.body.output.startsWith('[LOOP]'));
        assert.equal(logs.length, 3);
        logs.forEach((e, a) => {
            assert.match(e.body.output, new RegExp(`^\\[LOOP\\] A=${a} hex=\\$0${a} cnt=${a} lab=counter sig=${a - 10} f=[SZHPNC-]{6} \\{lit\\}\\n$`));
            assert.equal(e.body.line, L('LOGPOINT [LOOP]'));
            assert.equal(path.basename(e.body.source.path), 'keywords.asm');
        });
        assert.ok(c.outputs(from, 'console').some((e) => e.body.output === t('session.assertionFailed', 'A != 3') + ` (keywords.asm:${L('ASSERTION A != 3')})\n`));
    });

    test('LOGPOINT s neznámým návěštím vypíše ?, WPMEM zápis zastaví za instrukcí', opts, async () => {
        const from = c.events.length;
        const s = await c.cont();
        assert.equal(s.body.reason, 'WPMEM');
        assert.equal(s.body.description, t('session.stopWpmem', hex4(label('wtarget')), `keywords.asm:${L('WPMEM , 1, w')}`));
        assert.equal((await c.top()).line, L('ld a, (rtarget)'));
        const out = c.outputs(from, 'console').map((e) => e.body.output);
        assert.deepEqual(out.filter((o) => o.startsWith('[LOOP]')).map((o) => o.slice(0, 11)), ['[LOOP] A=3 ', '[LOOP] A=4 ']);
        assert.ok(out.includes('bad ? and 5\n'), JSON.stringify(out));
    });

    test('WPMEM čtení s podmínkou v syntaxi DeZog (A == 7 && !(B == 1))', opts, async () => {
        const s = await c.cont();
        assert.equal(s.body.reason, 'WPMEM');
        assert.equal(s.body.text, 'WPMEM rtarget, 1, r, A == 7 && !(B == 1)');
        assert.equal(s.body.description, t('session.stopWpmem', hex4(label('rtarget')), `keywords.asm:${L('WPMEM rtarget, 1, r')}`));
        assert.equal(await c.evaluate('A'), '$07 (7)');
    });

    test('BREAK = FD 00 (sjasmplus): magic breakpoint jádra zastaví ZA instrukcí', opts, async () => {
        const s = await c.cont();
        assert.equal(s.body.reason, t('session.stopMagic'));
        assert.equal(s.body.description, t('session.stopMagicDescription', hex4(label('brk_fd'))));
        const f = await c.top();
        assert.equal(f.line, L('        ld a, $42'));
        assert.equal(f.instructionPointerReference, '0x' + (label('brk_fd') + 2).toString(16));
    });

    test('DD 01 (CSpect): magic breakpoint serveru zastaví ZA instrukcí', opts, async () => {
        const s = await c.cont();
        assert.equal(s.body.reason, t('session.stopMagic'));
        assert.equal(s.body.description, t('session.stopMagicDescription', hex4(label('brk_dd'))));
        assert.equal((await c.top()).line, L('ld c, a'));
        assert.equal(await c.evaluate('A'), '$42 (66)');
    });

    test('prázdná ASSERTION zastaví vždy', opts, async () => {
        const s = await c.cont();
        assert.equal(s.body.reason, t('session.stopAssertion'));
        assert.equal(s.body.description, t('session.assertionEmpty'));
        assert.equal((await c.top()).line, L('nop                     ; ASSERTION'));
        assert.equal(await c.evaluate('C'), '$42 (66)');
    });

    test('pak už běží bez zastavení', opts, async () => {
        await c.ok('continue', { threadId: 1 });
        await sleep(300);
        const s = await c.until(() => c.ok('pause', { threadId: 1 }));
        assert.equal(s.body.reason, 'pause');
        assert.equal((await c.top()).line, L('jr finish'));
    });
});

describe('klíčová slova a BREAK vypnuté v launch.json', { skip: NO_SERVER, timeout: 60000 }, () => {
    test('wpmem/logpoints/assertions/magicBreakpoint false: žádné zastavení ani výpis', opts, async () => {
        const c = new DapClient('en');
        try {
            await c.launch({ program: kw.program, sld: kw.sld, wpmem: false, logpoints: false, assertions: false, magicBreakpoint: false });
            assert.equal(c.outputs(0, 'important').length, 0, 'bez varování ke klíčovým slovům');
            const from = c.events.length;
            await c.ok('continue', { threadId: 1 });
            await sleep(500);
            assert.equal(c.events.slice(from).filter((e) => e.event === 'stopped').length, 0);
            assert.equal(c.outputs(from, 'console').filter((e) => e.body.output.startsWith('[LOOP]')).length, 0);
            await c.until(() => c.ok('pause', { threadId: 1 }));
        } finally {
            await c.close();
        }
    });
});

describe('examples/features: LOGPOINT, BREAK a ASSERTION', { skip: NO_SERVER, timeout: 60000 }, () => {
    test('logy [DEMO] A=$01…$03, BREAK při A = 3, logy do $06, ASSERTION A < 6', opts, async () => {
        const features = program('features', path.join(REPO, 'examples', 'features'));
        const F = (text: string) => lineOf(features.source, text);
        const c = new DapClient('en');
        try {
            await c.launch({ program: features.program, sld: features.sld, sourceRoot: features.sourceRoot });
            assert.equal(c.outputs(0, 'important').length, 0, JSON.stringify(c.outputs(0, 'important')));
            let from = c.events.length;
            let s = await c.cont();
            assert.equal(s.body.reason, t('session.stopMagic'));
            assert.equal((await c.top()).line, F('out ($fe), a'), 'stojí za BREAK');
            assert.equal(await c.evaluate('A'), '$03 (3)');
            const logs = (i: number) => c.outputs(i, 'console').filter((e) => e.body.output.startsWith('[DEMO]'));
            assert.deepEqual(logs(from).map((e) => e.body.output), ['[DEMO] A=$01\n', '[DEMO] A=$02\n', '[DEMO] A=$03\n']);
            assert.equal(logs(from)[0].body.line, F('LOGPOINT [DEMO]'));
            from = c.events.length;
            s = await c.cont();
            assert.equal(s.body.reason, t('session.stopAssertion'));
            assert.equal(s.body.description, t('session.assertionFailed', 'A < 6'));
            assert.equal(await c.evaluate('A'), '$06 (6)');
            assert.equal((await c.top()).line, F('out ($fe), a'));
            assert.deepEqual(logs(from).map((e) => e.body.output), ['[DEMO] A=$04\n', '[DEMO] A=$05\n', '[DEMO] A=$06\n']);
        } finally {
            await c.close();
        }
    });
});
