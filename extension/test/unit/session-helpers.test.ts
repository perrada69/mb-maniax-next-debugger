// Ladicí sezení bez emulátoru (src/session.ts): překlad výrazů z VS Code a z komentářů (DeZog)
// do jazyka JNEXT, formáty logpointů, výpis logpointu ze serveru, evaluate / `m adresa` /
// setBreakpoints / důvody zastavení nad podvrženým serverem (zachycené požadavky a odpovědi DAP).
import { beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLanguage, t } from '../../src/i18n';
import { NextDebugSession } from '../../src/session';
import { SldInfo } from '../../src/sld';

setLanguage('en');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-sess-'));
const asm = path.join(dir, 'hello.asm');
fs.writeFileSync(path.join(dir, 'hello.sld'), [
    '|SLD.data.version|1',
    'hello.asm|7||0|4|32768|F|start',
    'hello.asm|8||0|4|32768|T|',
    'hello.asm|13||0|4|32774|F|main_loop',
    'hello.asm|14||0|4|32774|T|',
    'hello.asm|16||0|4|32779|F|main_loop.wait',
    'hello.asm|16||0|4|32779|T|',
    'hello.asm|21||0|4|32784|F|next_colour',
    'hello.asm|22||0|4|32784|T|',
    'hello.asm|23||0|30|32787|T|',
    'hello.asm|23||0|31|32787|T|',
    'hello.asm|29||0|4|32800|F|counter',
].join('\n'));
const sld = SldInfo.load(path.join(dir, 'hello.sld'));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Sezení se SLD; odpovědi a události DAP se sbírají, `server` je podvržený. */
function session(handler: (cmd: string, args: any) => any = () => ({})) {
    const s: any = new NextDebugSession('');
    const responses: any[] = [];
    const events: any[] = [];
    const requests: Array<[string, any]> = [];
    s.sld = sld;
    s.sendResponse = (r: any) => responses.push(r);
    s.sendEvent = (e: any) => events.push(e);
    s.server = {
        request: async (cmd: string, args: any = {}) => {
            requests.push([cmd, args]);
            const r = await handler(cmd, args);
            if (r instanceof Error) throw r;
            return { ok: true, ...r };
        },
        send: () => undefined,
        close: () => undefined,
    };
    return { s, responses, events, requests };
}
const resp = (command: string) => ({ seq: 0, type: 'response', request_seq: 1, command, success: true }) as any;

describe('překlad výrazů z VS Code (translate)', () => {
    const { s } = session();
    const tr = (e: string) => s.translate(e) as string;

    test('stínové registry AF\' … HL\' → AF2 … HL2', () => {
        assert.equal(tr("AF'"), 'AF2');
        assert.equal(tr("af' == hl'"), 'AF2 == HL2');
        assert.equal(tr("BC' + DE'"), 'BC2 + DE2');
    });

    test('poloviny IX/IY přes posun a masku', () => {
        assert.equal(tr('IXH'), '(IX >> 8)');
        assert.equal(tr('ixl'), '(IX & $FF)');
        assert.equal(tr('IYH + iyl'), '(IY >> 8) + (IY & $FF)');
    });

    test('registry velkými písmeny, návěští s @, lokální návěští jako adresa', () => {
        assert.equal(tr('a == 5 && hl > sp'), 'A == 5 && HL > SP');
        assert.equal(tr('next_colour'), '@next_colour');
        assert.equal(tr('main_loop.wait'), '$800B');
        assert.equal(tr('pc == main_loop'), 'PC == @main_loop');
        assert.equal(tr('@start'), '@start', 'už označené návěští zůstane');
        assert.equal(tr('neznamy + 1'), 'neznamy + 1');
    });

    test('čísla se nemění ($FF, 0x1F, #AB, 1Fh)', () => {
        assert.equal(tr('$ff + 0x1f + #ab + 1fh'), '$ff + 0x1f + #ab + 1fh');
        assert.equal(tr('mem[hl] == $c9'), 'mem[HL] == $c9');
    });
});

describe('výrazy z komentářů v syntaxi DeZog (translateDezog)', () => {
    const { s } = session();
    const tr = (e: string) => norm(s.translateDezog(e));

    test('logické operátory a porovnání', () => {
        assert.equal(tr('A == 7 && !(B == 1)'), 'A == 7 and not (B == 1)');
        assert.equal(tr('a = 5 || b != 3'), 'A == 5 or B != 3');
        assert.equal(tr('A <= 5 && A >= 1'), 'A <= 5 and A >= 1');
    });

    test('čísla #FF, 0FFh, %1010 (ale % jako zbytek po dělení zůstane)', () => {
        assert.equal(tr('A == #FF'), 'A == $FF');
        assert.equal(tr('HL == 0C000h'), 'HL == $0C000');
        assert.equal(tr('A == %1010'), 'A == 0b1010');
        assert.equal(tr('A %10'), 'A %10');
    });

    test('b@( … ) a w@( … ) i vnořené; návěští a registry přeložené', () => {
        assert.equal(tr('b@(HL)'), 'mem[HL]');
        assert.equal(tr('w@(counter + 1) == $1234'), 'mem16[@counter + 1] == $1234');
        assert.equal(tr('b@(w@(ix) + (1))'), 'mem[mem16[IX] + (1)]');
        assert.equal(tr("b@(HL) == AF'"), 'mem[HL] == AF2');
        assert.equal(tr('b@(HL'), 'B@(HL', 'neuzavřená závorka zůstane (chybu ohlásí server)');
    });
});

describe('logpointy: značky formátů a formátování hodnot', () => {
    const { s } = session();

    test('translateLog: {výraz} a {výraz:formát} se značkou formátu a šířky', () => {
        assert.equal(s.translateLog('A={a} hl={hl:hex}'), 'A={A} hl=\x01h2{HL}\x02');
        assert.equal(s.translateLog('{a:signed}/{ixh:bits}/{f:flags}/{pc:labels}/{a:char}/{a+1:unsigned}'),
            '\x01s1{A}\x02/\x01b1{(IX >> 8)}\x02/\x01f1{F}\x02/\x01l2{PC}\x02/\x01c1{A}\x02/\x01u0{A+1}\x02');
        assert.equal(s.translateLog('{x:weird}'), '{x:weird}', 'neznámý formát → celý výraz serveru');
        assert.equal(s.translateLog('bez výrazu'), 'bez výrazu');
    });

    test('formatLogValue: hex, signed, unsigned, char, bits, flags, labels, ?', () => {
        const f = (fmt: string, size: string, v: string) => s.formatLogValue(fmt, size, v) as string;
        assert.equal(f('h', '1', '255'), '$FF');
        assert.equal(f('h', '0', '255'), '$FF');
        assert.equal(f('h', '0', '256'), '$0100');
        assert.equal(f('h', '2', '5'), '$0005');
        assert.equal(f('h', '0', '70000'), '$00011170');
        assert.equal(f('s', '1', '255'), '-1');
        assert.equal(f('s', '2', '65535'), '-1');
        assert.equal(f('s', '0', '-10'), '-10');
        assert.equal(f('u', '1', '-1'), '255');
        assert.equal(f('u', '0', '-10'), '-10');
        assert.equal(f('c', '1', '65'), 'A');
        assert.equal(f('c', '1', '7'), '$07');
        assert.equal(f('b', '1', '5'), '00000101');
        assert.equal(f('f', '1', String(0xc1)), 'SZ---C');
        assert.equal(f('f', '1', '0'), '------');
        assert.equal(f('l', '2', String(0x8010)), 'next_colour');
        assert.equal(f('l', '2', String(0x8013)), 'next_colour+3');
        assert.equal(f('l', '2', String(0x1234)), '$1234');
        assert.equal(f('h', '1', '?'), '?');
    });

    test('výpis ze serveru: značky → text, složené závorky z textu, místo LOGPOINT ve zdrojáku', () => {
        const { s: t2, events } = session();
        t2.keywordBps = [{ kw: { kind: 'LOGPOINT', file: asm, line: 22, addr: 0x8010, page: 4, args: '' }, logMessage: 'x' }];
        t2.onServerEvent({ event: 'output', text: '\x060\x07[G] A=\x01h15\x02 l=\x01l232784\x02 \x04lit\x05\n' });
        t2.onServerEvent({ event: 'output', text: 'obyčejný výpis\n' });
        assert.equal(events.length, 2);
        assert.equal(events[0].body.output, '[G] A=$05 l=next_colour {lit}\n');
        assert.equal(events[0].body.source.path, asm);
        assert.equal(events[0].body.line, 22);
        assert.equal(events[1].body.output, 'obyčejný výpis\n');
        assert.equal(events[1].body.source, undefined);
    });
});

describe('DAP nad podvrženým serverem', () => {
    let mem: Uint8Array;
    let values: Record<string, number>;
    let ctx: ReturnType<typeof session>;
    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        for (let i = 0; i < 0x40; i++) mem[0x8000 + i] = 0x41 + (i % 26);
        values = { '@next_colour': 0x8010, A: 5, '$8000': 0x8000, '20': 20, '70000': 70000, '@main_loop': 0x8006 };
        ctx = session((cmd, a) => {
            if (cmd === 'evaluate') return a.expr in values ? { value: values[a.expr] } : new Error(`unknown name \`${a.expr}\``);
            if (cmd === 'readMemory') return { data: Buffer.from(mem.subarray(a.addr, a.addr + a.length)).toString('base64') };
            if (cmd === 'setBreakpoints') return { breakpoints: a.breakpoints.map((b: any) => ({ id: b.id, verified: b.addr !== 0x8013 })) };
            return {};
        });
    });

    test('evaluate: návěští s obsahem paměti, registr bez, velké číslo desítkově', async () => {
        const { s, responses, requests } = ctx;
        await s.evaluateRequest(resp('evaluate'), { expression: 'next_colour', context: 'watch' });
        assert.deepEqual(requests[0], ['evaluate', { expr: '@next_colour' }]);
        assert.equal(responses[0].body.result, '$8010 (32784)  → [$51] [$5251]');
        assert.equal(responses[0].body.memoryReference, '0x8010');
        await s.evaluateRequest(resp('evaluate'), { expression: 'a', context: 'watch' });
        assert.equal(responses[1].body.result, '$05 (5)');
        assert.equal(requests.filter((r) => r[0] === 'readMemory').length, 1);
        await s.evaluateRequest(resp('evaluate'), { expression: '70000', context: 'repl' });
        assert.equal(responses[2].body.result, '70000');
    });

    test('evaluate: chyba serveru jako chybová odpověď, při najetí myší tiše', async () => {
        const { s, responses } = ctx;
        await s.evaluateRequest(resp('evaluate'), { expression: 'nesmysl', context: 'watch' });
        assert.equal(responses[0].success, false);
        assert.match(responses[0].message, /nesmysl/);
        await s.evaluateRequest(resp('evaluate'), { expression: 'nesmysl', context: 'hover' });
        assert.equal(responses[1].success, false);
        assert.equal(responses[1].message, undefined);
    });

    test('Debug Console `m adresa, délka`: hex výpis po 16 B s textem a návěštím', async () => {
        const { s, responses } = ctx;
        await s.evaluateRequest(resp('evaluate'), { expression: 'm $8000, 20', context: 'repl' });
        const lines = responses[0].body.result.split('\n');
        assert.equal(lines.length, 2);
        assert.equal(lines[0], '$8000  41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F 50  ABCDEFGHIJKLMNOP  start');
        assert.equal(lines[1], '$8010  ' + '51 52 53 54'.padEnd(47) + '  QRST  next_colour');
        await s.evaluateRequest(resp('evaluate'), { expression: 'm main_loop', context: 'repl' });
        assert.equal(responses[1].body.result.split('\n').length, 8, 'výchozí délka 128 B');
        assert.ok(responses[1].body.result.startsWith('$8006  47 48'));
        await s.evaluateRequest(resp('evaluate'), { expression: 'm main_loop', context: 'watch' });
        assert.equal(responses[2].success, false, 'm jen v Debug Console');
    });

    test('setBreakpoints: řádek → adresy se stránkami, překlad podmínky a logpointu, řádek bez kódu', async () => {
        const { s, responses, requests } = ctx;
        await s.setBreakPointsRequest(resp('setBreakpoints'), {
            source: { path: asm },
            breakpoints: [
                { line: 21, condition: 'a == 5 && counter > 2', hitCondition: '>= 3' },
                { line: 23, logMessage: 'A={a:hex} IXH={ixh}' },
                { line: 30 },
            ],
        });
        const sent = requests.find((r) => r[0] === 'setBreakpoints')![1].breakpoints;
        assert.deepEqual(sent.map((b: any) => [b.addr, b.page]), [[0x8010, 4], [0x8013, 30], [0x8013, 31]]);
        assert.equal(sent[0].condition, 'A == 5 && @counter > 2');
        assert.equal(sent[0].hitCondition, '>= 3');
        assert.equal(sent[1].logMessage, 'A=\x01h1{A}\x02 IXH={(IX >> 8)}');
        const bps = responses[0].body.breakpoints;
        assert.deepEqual(bps.map((b: any) => [b.line, b.verified]), [[22, true], [23, false], [30, false]]);
        assert.equal(bps[2].message, t('session.noInstruction'));
        assert.equal(bps[0].instructionReference, '0x8010');
    });

    test('zastavení: BREAK DD 01 (adresa instrukce = PC − 2), událost stroje, obnovený stav', () => {
        const { s, events } = ctx;
        s.onServerEvent({ event: 'stopped', reason: 'magic', pc: 0x8012 });
        assert.equal(events[0].body.reason, t('session.stopMagic'));
        assert.equal(events[0].body.description, t('session.stopMagicDescription', '$8010'));
        s.onServerEvent({ event: 'stopped', reason: 'event', eventKind: 'interrupt', pc: 0x38 });
        assert.equal(events[1].body.reason, t('session.filterInterrupt'));
        s.onServerEvent({ event: 'stopped', reason: 'restore', pc: 0 });
        assert.equal(events[2].event, 'memory', 'obnovený stav → překreslit paměť');
        assert.equal(events[3].body.reason, t('session.stopRestore'));
        s.onServerEvent({ event: 'stopped', reason: 'frameBoundary', pc: 0 });
        assert.equal(events[4].body.reason, t('session.stopFrameBoundary'));
        assert.ok(events.every((e) => e.event !== 'stopped' || e.body.allThreadsStopped));
    });
});
