// Integrační test DAP na examples/hello (předpřeložený v test/fixtures, zdroják z examples/hello):
// vstup, breakpoint s podmínkou, krok, zásobník, proměnné, evaluate (AF', IXH, lokální návěští,
// `m start`), logpoint, Jump to Cursor, uložené stavy, profiler, příkazy panelu Next, rychlost
// emulace a zvuk. Všechno nad jedním serverem; testy jdou po sobě a navazují.
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { t } from '../../src/i18n';
import { aggregateProfile, parseProfile } from '../../src/profiler';
import { DapClient, lineOf, NO_SERVER, program, REPO, sleep, valueOf } from './dap-client';

const hello = program('hello', path.join(REPO, 'examples', 'hello'));
const L = (text: string) => lineOf(hello.source, text);
const opts = { skip: NO_SERVER, timeout: 30000 };

describe('DAP: examples/hello', { skip: NO_SERVER, timeout: 120000 }, () => {
    let c: DapClient;
    before(async () => {
        c = new DapClient('en');
        await c.launch({ program: hello.program, sld: hello.sld, sourceRoot: hello.sourceRoot });
    });
    after(async () => {
        await c?.close();
    });

    test('zastavení na vstupu: první instrukce, vlákno, rámec se zdrojákem', opts, async () => {
        const th = await c.ok('threads');
        assert.deepEqual(th.threads.map((x: any) => x.id), [1]);
        const f = await c.top();
        assert.equal(f.name, 'start');
        assert.equal(f.line, L('        ei'));
        assert.equal(path.normalize(f.source.path).toLowerCase(), path.normalize(hello.source).toLowerCase());
        assert.equal(f.instructionPointerReference, '0x8000');
    });

    test('scopes a variables: registry, příznaky, stínové, stroj (MMU)', opts, async () => {
        const scopes = (await c.ok('scopes', { frameId: 0 })).scopes;
        assert.equal(scopes.length, 4);
        const vars = async (i: number) => (await c.ok('variables', { variablesReference: scopes[i].variablesReference })).variables;
        const regs = await vars(0);
        assert.deepEqual(regs.map((v: any) => v.name), ['AF', 'BC', 'DE', 'HL', 'IX', 'IY', 'SP', 'PC', 'I', 'R', 'IM', 'IFF1']);
        assert.match(regs.find((v: any) => v.name === 'PC').value, /^\$8000 \(32768\)\s+start/);
        assert.deepEqual((await vars(1)).map((v: any) => v.name), ['S', 'Z', 'H', 'P/V', 'N', 'C']);
        assert.deepEqual((await vars(2)).map((v: any) => v.name), ["AF'", "BC'", "DE'", "HL'"]);
        const machine = await vars(3);
        assert.ok(machine.some((v: any) => v.name.startsWith('MMU4') && v.value.includes('4')), JSON.stringify(machine));
    });

    test('setVariable a evaluate: IX/IXH/IXL, AF\', lokální návěští, návěští s obsahem paměti', opts, async () => {
        const regs = (await c.ok('scopes', { frameId: 0 })).scopes[0].variablesReference;
        const set = await c.ok('setVariable', { variablesReference: regs, name: 'IX', value: '$1234' });
        assert.equal(set.value, '$1234 (4660)');
        assert.equal(valueOf(await c.evaluate('IX')), 0x1234);
        assert.equal(valueOf(await c.evaluate('IXH')), 0x12);
        assert.equal(valueOf(await c.evaluate('ixl')), 0x34);
        assert.equal(valueOf(await c.evaluate('IXH == (IX >> 8)')), 1);
        await c.ok('setVariable', { variablesReference: regs, name: "AF'", value: '$ABCD' });
        assert.equal(valueOf(await c.evaluate("AF'")), 0xabcd);
        assert.equal(valueOf(await c.evaluate('main_loop.wait')), c.session.getSld()!.label('main_loop.wait')!.addr);
        const nc = await c.evaluate('next_colour');
        assert.match(nc, /^\$80[0-9A-F]{2} \(\d+\)\s+→ \[\$[0-9A-F]{2}\] \[\$[0-9A-F]{4}\]$/);
        assert.equal(valueOf(nc), c.session.getSld()!.label('next_colour')!.addr);
        const err = await c.request('evaluate', { expression: 'nosuchname + 1', context: 'watch' });
        assert.equal(err.success, false);
    });

    test('Debug Console `m start` a `m counter, 1`', opts, async () => {
        const dump = (await c.ok('evaluate', { expression: 'm start', context: 'repl' })).result.split('\n');
        assert.equal(dump.length, 8);
        assert.match(dump[0], /^\$8000  FB 31 /);   // ei; ld sp, …
        assert.ok(dump[0].endsWith('  start'), dump[0]);
        const one = (await c.ok('evaluate', { expression: 'm counter, 1', context: 'repl' })).result;
        assert.match(one, /^\$80[0-9A-F]{2}  [0-9A-F]{2}\s+.\s+counter$/);
    });

    test('breakpoint s podmínkou: zastaví v next_colour při A == 2, zásobník s volajícím', opts, async () => {
        const line = L('out ($fe), a');
        const bp = await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [{ line, condition: 'A == 2' }] });
        assert.deepEqual(bp.breakpoints.map((b: any) => [b.line, b.verified]), [[line, true]]);
        const stop = await c.cont();
        assert.equal(stop.body.reason, 'breakpoint');
        assert.deepEqual(stop.body.hitBreakpointIds, [bp.breakpoints[0].id]);
        assert.equal(await c.evaluate('A'), '$02 (2)');
        const st = (await c.ok('stackTrace', { threadId: 1 })).stackFrames;
        assert.equal(st[0].line, line);
        assert.match(st[0].name, /^next_colour\+\d+$/);
        assert.equal(st.length, 2);
        assert.equal(st[1].line, L('call next_colour'));
    });

    test('kroky: stepOver na ret, stepIn zpět do main_loop', opts, async () => {
        let s = await c.until(() => c.ok('next', { threadId: 1 }));
        assert.equal(s.body.reason, 'step');
        assert.equal((await c.top()).line, L('        ret'));
        s = await c.until(() => c.ok('stepIn', { threadId: 1 }));
        assert.equal((await c.top()).line, L('ld b, 25'));
        assert.equal((await c.ok('stackTrace', { threadId: 1 })).stackFrames.length, 1);
        const back = await c.request('stepBack', { threadId: 1 });
        assert.equal(back.success, false, 'stepBack bez rewind');
    });

    test('logpoint z VS Code s formátem a breakpoint za ním', opts, async () => {
        const from = c.events.length;
        await c.ok('setBreakpoints', {
            source: { path: hello.source },
            breakpoints: [{ line: L('out ($fe), a'), logMessage: 'A={A:hex} counter={mem[counter]} raw={A}' }, { line: L('        ret') }],
        });
        const s = await c.cont();
        assert.equal(s.body.reason, 'breakpoint');
        const out = c.outputs(from, 'console').map((e) => e.body.output);
        const log = out.find((o) => o.startsWith('A='));
        // výrazy z VS Code jsou v jazyce JNEXT (mem[…]); návěští dostane @
        assert.equal(log, 'A=$03 counter=3 raw=3\n', JSON.stringify(out));
    });

    test('Jump to Cursor: cíle pro řádek, goto přesune PC, řádek bez kódu nemá cíl', opts, async () => {
        await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [] });
        const line = L('ld (counter), a');
        const gt = await c.ok('gotoTargets', { source: { path: hello.source }, line });
        assert.equal(gt.targets.length, 1);
        const addr = c.session.getSld()!.addressesFor(hello.source, line)!.addrs[0].addr;
        assert.equal(gt.targets[0].label, t('session.gotoTarget', '$' + addr.toString(16).toUpperCase().padStart(4, '0'), 4));
        const s = await c.until(() => c.ok('goto', { threadId: 1, targetId: gt.targets[0].id }));
        assert.equal(s.body.reason, 'goto');
        const f = await c.top();
        assert.equal(f.line, line);
        assert.equal(f.instructionPointerReference, '0x' + addr.toString(16));
        assert.deepEqual((await c.ok('gotoTargets', { source: { path: hello.source }, line: 200 })).targets, []);
        const bad = await c.request('goto', { threadId: 1, targetId: 99 });
        assert.equal(bad.success, false);
    });

    test('pauza za běhu', opts, async () => {
        await c.ok('continue', { threadId: 1 });
        await sleep(200);
        const s = await c.until(() => c.ok('pause', { threadId: 1 }));
        assert.equal(s.body.reason, 'pause');
    });

    test('uložené stavy: save (doběh na hranici snímku), restore, list, chyby, export/import', opts, async () => {
        const counter = c.session.getSld()!.label('counter')!.addr;
        const read = async () => (await c.ok('readMemory', { memoryReference: '0x' + counter.toString(16), count: 1 })).data;
        // uprostřed snímku bez advance → notAtFrameBoundary (nebo se uloží, stál-li náhodou na hranici)
        await c.server('stateSave', { name: 'a' }).catch((e: Error) => assert.match(e.message, /notAtFrameBoundary/));
        await c.server('stateSave', { name: 'a', advance: true });
        await sleep(100);
        assert.ok((await c.server('stateList')).names.includes('a'));
        const saved = await read();
        await c.ok('writeMemory', { memoryReference: '0x' + counter.toString(16), data: Buffer.from([0x77]).toString('base64') });
        assert.equal(Buffer.from(await read(), 'base64')[0], 0x77);
        const from = c.events.length;
        const s = await c.until(() => c.server('stateRestore', { name: 'a' }));
        assert.equal(s.body.reason, t('session.stopRestore'));
        assert.ok(c.events.slice(from).some((e) => e.event === 'memory'), 'po obnovení MemoryEvent');
        assert.equal(await read(), saved);
        await assert.rejects(c.server('stateRestore', { name: 'nic' }), /notFound/);
        const exp = await c.server('stateExport', { advance: true });
        assert.ok(exp.size > 1000000, 'velikost stavu ' + exp.size);
        assert.equal(Buffer.from(exp.data, 'base64').length, exp.size);
        await c.ok('writeMemory', { memoryReference: '0x' + counter.toString(16), data: Buffer.from([0x55]).toString('base64') });
        const s2 = await c.until(() => c.server('stateImport', { data: exp.data }));
        assert.equal(s2.body.reason, t('session.stopRestore'));
        assert.notEqual(Buffer.from(await read(), 'base64')[0], 0x55);
        await assert.rejects(c.server('stateImport', { data: Buffer.from('nesmysl').toString('base64') }), /incompatible/);
    });

    test('profiler: T-stavy za běhu, součet záznamů = total = přírůstek T-stavů stroje, funkce ze SLD', opts, async () => {
        assert.equal((await c.server('profilerStart')).active, true);
        await c.server('profilerClear');
        const s0 = await c.server('state');
        // do konce next_colour (volá se jednou za 25 snímků): v datech je jistě main_loop i next_colour
        await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [{ line: L('        ret') }] });
        assert.equal((await c.cont()).body.reason, 'breakpoint');
        await c.ok('setBreakpoints', { source: { path: hello.source }, breakpoints: [] });
        const s1 = await c.server('state');
        const raw = await c.server('profilerData');
        assert.equal(raw.active, true);
        const data = parseProfile(raw);
        const sum = data.entries.reduce((a, e) => a + e.t, 0);
        assert.ok(sum > 0);
        assert.equal(raw.total, sum, 'total = součet t');
        assert.equal(raw.count, raw.entries.length);
        const dt = s1.tstates - s0.tstates;
        assert.ok(dt > 0);
        assert.equal(sum, dt, 'profiler počítá každý T-stav CPU od vynulování');
        const sum2 = aggregateProfile(data, c.session.getSld());
        const names = sum2.functions.map((f) => f.name);
        assert.ok(names.includes('main_loop') && names.includes('next_colour'), names.join());
        assert.ok(sum2.files.size >= 1);
        const bin = await c.server('profilerData', { format: 'binary' });
        assert.equal(Buffer.from(bin.data, 'base64').length, raw.count * 16);
        await c.server('profilerStop');
        assert.equal((await c.server('profilerData')).active, false);
    });

    test('panel Next: sprites, patternRam, palettes, copper, nextregs', opts, async () => {
        const sp = await c.server('sprites');
        assert.equal(sp.sprites.length, 128);
        assert.equal(Buffer.from(sp.attrs, 'base64').length, 640);
        assert.deepEqual(Object.keys(sp.clip).sort(), ['x1', 'x2', 'y1', 'y2']);
        for (const k of ['x', 'y', 'pattern', 'visible', 'relative', 'anchor']) assert.ok(k in sp.sprites[0], k);
        assert.equal(Buffer.from((await c.server('patternRam')).data, 'base64').length, 16384);
        const pl = await c.server('palettes');
        assert.deepEqual(Object.keys(pl.banks).sort(), ['layer2_0', 'layer2_1', 'sprite0', 'sprite1', 'tilemap0', 'tilemap1', 'ula0', 'ula1']);
        for (const b of Object.values(pl.banks) as number[][]) {
            assert.equal(b.length, 256);
            assert.ok(b.every((v) => Number.isInteger(v) && v >= 0 && v < 512));
        }
        assert.ok(pl.activeUla === 0 || pl.activeUla === 1);
        const cp = await c.server('copper');
        assert.equal(Buffer.from(cp.program, 'base64').length, 2048);
        assert.ok(cp.pc >= 0 && cp.pc < 1024);
        const nr = Buffer.from((await c.server('nextregs')).data, 'base64');
        assert.equal(nr.length, 256);
        assert.equal(nr[0x07] & 3, 3, 'hello nastaví 28 MHz (NR $07 = 3)');
    });

    test('panel Next: renderLayer všech vrstev, neznámá vrstva je chyba', opts, async () => {
        for (const layer of ['composite', 'ula', 'ulaShadow', 'layer2', 'layer2Shadow', 'sprites', 'tilemap', 'background']) {
            const r = await c.server('renderLayer', { layer });
            assert.equal(r.width, 640, layer);
            assert.equal(r.height, 256, layer);
            const px = Buffer.from(r.data, 'base64');
            assert.equal(px.length, 640 * 256 * 4, layer);
            if (layer === 'composite' || layer === 'background') {
                for (let i = 3; i < px.length; i += 4 * 997) assert.equal(px[i], 255, `${layer}: neprůhledný`);
            }
        }
        await assert.rejects(c.server('renderLayer', { layer: 'bogus' }));
    });

    test('panel Next: readMemory se stránkou (souvisle přes stránky, mapování, meze)', opts, async () => {
        const b = async (args: any) => Buffer.from((await c.server('readMemory', args)).data, 'base64');
        const big = await b({ page: 10, addr: 0, length: 0x6000 });
        assert.equal(big.length, 0x6000);
        const parts = Buffer.concat([await b({ page: 10, addr: 0, length: 0x2000 }), await b({ page: 11, addr: 0, length: 0x2000 }), await b({ page: 12, addr: 0, length: 0x2000 })]);
        assert.ok(big.equals(parts), 'čtení přes stránky = stránky za sebou');
        assert.equal((await b({ page: 10, addr: 0x1ff0, length: 0x30000 })).length, 0x30000);
        const mmu = (await c.server('mmu')).slots.map((s: any) => s.page);
        assert.equal(mmu.length, 8);
        const viaPage = await b({ page: mmu[4], addr: 0, length: 64 });
        const viaCpu = await b({ addr: 0x8000, length: 64 });
        assert.ok(viaPage.equals(viaCpu), 'stránka ve slotu 4 = paměť CPU od $8000');
        assert.equal(viaCpu[0], 0xfb, 'ei na začátku programu');
        await assert.rejects(c.server('readMemory', { page: 0xe0, addr: 0, length: 16 }), /invalid_page/);
        const dap = await c.ok('readMemory', { memoryReference: '0x8000', count: 4 });
        assert.equal(dap.address, '0x8000');
        assert.ok(Buffer.from(dap.data, 'base64').equals(viaCpu.subarray(0, 4)));
    });

    test('disassemble kolem PC se symboly a řádky', opts, async () => {
        const start = c.session.getSld()!.label('next_colour')!.addr;
        const d = await c.ok('disassemble', { memoryReference: '0x' + start.toString(16), instructionCount: 6, instructionOffset: -2 });
        assert.equal(d.instructions.length, 6);
        const i = d.instructions.findIndex((x: any) => x.address === '0x' + start.toString(16));
        assert.equal(i, 2);
        assert.equal(d.instructions[i].symbol, 'next_colour');
        assert.match(d.instructions[i].instruction, /^ld a,?\s*\(/i);
        assert.equal(d.instructions[i].line, L('ld a, (counter)'));
    });

    test('rychlost emulace: aspoň 45 snímků/s a obraz ze serveru', { ...opts, timeout: 40000 }, async () => {
        await c.ok('continue', { threadId: 1 });
        await sleep(300);
        // Souběžně běží další testy s emulátorem (node --test pouští soubory paralelně): měří se
        // v oknech po 1 s, až 10 s, stačí jedno okno ≥ 45 (ostatní soubory mezitím doběhnou).
        const measured: number[] = [];
        for (let i = 0; i < 10 && !measured.some((f) => f >= 45); i++) {
            const f0 = await c.session.frameNumber();
            const t0 = Date.now();
            await sleep(1000);
            const f1 = await c.session.frameNumber();
            measured.push(((f1! - f0!) * 1000) / (Date.now() - t0));
        }
        const text = measured.map((f) => f.toFixed(1)).join(', ') + ' snímků/s';
        assert.ok(Math.max(...measured) >= 45, text);
        assert.ok(Math.max(...measured) < 70, text + ' (emulace se nebrzdí na 50 Hz?)');
        await c.server('screen');
        await sleep(200);
        assert.ok(c.sink.frames > 0, 'žádný obraz');
        assert.deepEqual([c.sink.lastFrame!.width, c.sink.lastFrame!.height], [640, 256]);
        assert.equal(c.sink.lastFrame!.length, 640 * 256 * 4);
    });

    test('zvuk: souvislý tok 44,1 kHz stereo (asi 882 vzorků na emulovaný snímek), vypnutí zastaví tok', opts, async () => {
        await c.server('audio', { on: true });
        await sleep(300);
        const b0 = c.sink.audioBytes;
        const n0 = c.sink.audioBlocks;
        const f0 = (await c.session.frameNumber())!;
        await sleep(1500);
        const f1 = (await c.session.frameNumber())!;
        const samples = (c.sink.audioBytes - b0) / 4;   // int16 stereo
        const blocks = c.sink.audioBlocks - n0;
        await c.server('audio', { on: false });
        // vůči emulovaným snímkům (ne hodinám), ať test nezávisí na zátěži stroje
        const perFrame = samples / (f1 - f0);
        assert.ok(f1 - f0 >= 10, `${f1 - f0} snímků za 1,5 s`);
        assert.ok(perFrame > 882 * 0.85 && perFrame < 882 * 1.15, `${perFrame.toFixed(0)} vzorků na snímek (${samples} / ${f1 - f0})`);
        assert.ok(blocks >= (f1 - f0) / 4, `${blocks} bloků na ${f1 - f0} snímků`);
        await sleep(200);
        const off = c.sink.audioBytes;
        await sleep(300);
        assert.equal(c.sink.audioBytes, off, 'po audio off žádný zvuk');
        await c.until(() => c.ok('pause', { threadId: 1 }));
    });
});
