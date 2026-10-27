// Pohled WiFi (ESP) (media/views/esp.js) nad podvrženým DOM a falešným serverem podle docs/next-views.md:
// druhy řádků, řídicí znaky, zkrácení, hlavička +IPD, přírůstkové načítání od seq (poslední kus roste),
// nové sezení (epoch), filtr, Hex, Vymazat, stav modulu a události spojení, texty v en/cs/de.
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { byClass, checkTexts, dictionary, domStrings, FakeElement, findAll, loadViews, makeApi, TEST_LANGS, tick, translator } from './fakedom';

const AREAS = ['esp'];
const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');

/** Falešný server: záznam kusů a stav modulu (smlouva espLog / espState / espClear). */
function fakeServer() {
    const srv = {
        epoch: 7,
        log: [] as any[],
        nextSeq: 1,
        bytesTx: 0,
        bytesRx: 0,
        state: { enabled: true, associated: true, stationIp: '192.168.1.50', allowedHosts: ['10.0.0.5'], events: [] as any[] } as any,
        add(dir: 'tx' | 'rx', text: string, frame = 100) {
            srv.log.push({ seq: srv.nextSeq++, dir, frame, t: frame * 70000, data: b64(text) });
            if (dir === 'tx') srv.bytesTx += text.length;
            else srv.bytesRx += text.length;
        },
        /** poslední kus narostl (ještě neskončil \n) */
        grow(text: string) {
            const last = srv.log[srv.log.length - 1];
            last.data = b64(Buffer.from(last.data, 'base64').toString('latin1') + text);
        },
        handle(cmd: string, args: any) {
            if (cmd === 'espState') return JSON.parse(JSON.stringify(srv.state));
            if (cmd === 'espClear') {
                srv.log = [];
                srv.epoch++;
                return {};
            }
            if (cmd === 'espLog') {
                const since = args.since ?? 0;
                return {
                    enabled: srv.state.enabled, epoch: srv.epoch, first: srv.log[0]?.seq ?? srv.nextSeq, next: srv.nextSeq,
                    bytesTx: srv.bytesTx, bytesRx: srv.bytesRx,
                    entries: srv.log.filter((e) => e.seq >= since).map((e) => ({ ...e })),
                };
            }
            throw new Error('neznámý dotaz ' + cmd);
        },
    };
    return srv;
}

for (const lang of TEST_LANGS) {
    describe(`pohled WiFi (ESP) [${lang}]`, () => {
        const texts = dictionary(lang, AREAS);
        const T = translator(texts);
        const srv = fakeServer();
        const api = makeApi(lang, texts, (cmd, args) => srv.handle(cmd, args));
        const { defs } = loadViews(['esp.js'], lang, texts);
        const view = defs.esp;
        const H = view.helpers;
        const root = new FakeElement('div');
        const rowsOf = () => findAll(root, byClass('esp-row'));
        const dataOf = (r: FakeElement) => findAll(r, byClass('esp-data'))[0].textContent;

        test('registrace a čisté funkce: druh řádku, řídicí znaky, zkrácení, +IPD, filtr', () => {
            assert.equal(view.order, 88);
            assert.equal(view.title, T('esp.title'));
            assert.equal(H.classify(false, 'AT+CIPSTART="TCP","x",80\r\n'), 'cmd');
            assert.equal(H.classify(false, 'AT\r\n'), 'cmd');
            assert.equal(H.classify(false, 'GET / HTTP/1.0\r\n'), '');
            assert.equal(H.classify(true, 'OK\r\n'), 'ok');
            assert.equal(H.classify(true, 'SEND OK\r\n'), 'ok');
            assert.equal(H.classify(true, 'ERROR\r\n'), 'err');
            assert.equal(H.classify(true, '+IPD,12:HTTP/1.0 200\r\n'), 'ipd');
            assert.equal(H.classify(true, 'CLOSED\r\n'), 'evt');
            assert.equal(H.classify(true, '0,CONNECT\r\n'), 'evt');
            assert.equal(H.classify(true, '+CWJAP:"net","aa",1,-50\r\n'), 'evt');
            assert.equal(H.classify(true, 'hello'), '');
            assert.deepEqual(JSON.parse(JSON.stringify(H.segments('AT\r\n', false, 0))), [{ text: 'AT', ctrl: false }, { text: '↵', ctrl: true }]);
            assert.deepEqual(JSON.parse(JSON.stringify(H.segments('a\x01\nb\r', false, 0))).map((s: any) => s.text), ['a', '\\x01', '\\n', 'b', '\\r']);
            assert.deepEqual(JSON.parse(JSON.stringify(H.segments('AT\r\n', true, 0))), [{ text: '41 54 0D 0A', ctrl: false }]);
            const cut = JSON.parse(JSON.stringify(H.segments('x'.repeat(200), false, 160)));
            assert.equal(cut[0].text.length, 160);
            assert.equal(cut[1].more, 40);
            assert.equal(H.ipdHeader('+IPD,0,12:data'), 10);
            assert.equal(H.ipdHeader('OK'), 0);
            assert.ok(H.matches('', 'x') && H.matches('cip', 'AT+CIPSEND') && !H.matches('ok', 'ERROR'));
            assert.equal(H.asText([{ frame: 5, rx: false, text: 'AT\r\n' }, { frame: 6, rx: true, text: 'OK\r\n' }]), '5\tZ80→ESP\tAT↵\n6\tESP→Z80\tOK↵');
            assert.equal(H.latin1(new Uint8Array([0x41, 0xe9])), 'Aé');
        });

        test('bez sezení: hláška, žádný dotaz', async () => {
            view.mount(root, api);
            api.state.attached = false;
            await view.refresh(api);
            assert.ok(root.textContent.includes(T('esp.noSession')), JSON.stringify(root.textContent.slice(-300)));
            assert.equal(api.log.length, 0);
            api.state.attached = true;
        });

        test('záznam: řádky obou směrů, druhy, stav modulu, události spojení', async () => {
            srv.add('tx', 'AT\r\n', 100);
            srv.add('rx', '\r\nOK\r\n', 101);
            srv.add('tx', 'AT+CIPSTART="TCP","10.0.0.5",80\r\n', 102);
            srv.add('rx', 'CONNECT\r\n', 103);
            srv.add('rx', '+IPD,5:Ahoj\r\n', 104);
            srv.state.events = [{ kind: 'opened', host: '10.0.0.5', port: 80, detail: '' }, { kind: 'refused', host: 'evil', port: 80, detail: 'not in list' }];
            await view.refresh(api);
            const rows = rowsOf();
            assert.equal(rows.length, 5);
            assert.ok(rows[0].classList.contains('tx') && rows[0].classList.contains('cmd'));
            assert.ok(rows[1].classList.contains('rx'));
            assert.ok(rows[4].classList.contains('ipd'));
            assert.equal(findAll(rows[4], byClass('esp-ipd'))[0].textContent, '+IPD,5:');
            assert.equal(dataOf(rows[0]), 'AT↵');
            assert.equal(findAll(rows[0], byClass('esp-frame'))[0].textContent, '100');
            assert.equal(rows[0].title, T('esp.rowTip', 1, 100, 7000000, 4));
            const info = findAll(root, byClass('esp-info'))[0].textContent;
            assert.ok(info.includes(T('esp.associated', '192.168.1.50')), info);
            assert.ok(info.includes(T('esp.allowedHosts', '10.0.0.5')), info);
            assert.ok(info.includes(T('esp.bytes', srv.bytesTx, srv.bytesRx)), info);
            const ev = findAll(root, byClass('esp-events'))[0];
            assert.ok(ev.textContent.includes(T('esp.evOpened')) && ev.textContent.includes('10.0.0.5:80'));
            assert.ok(ev.textContent.includes(T('esp.evRefused')) && ev.textContent.includes('not in list'));
            assert.ok(findAll(root, byClass('esp-empty'))[0].hidden);
            checkTexts(domStrings(root), lang, AREAS, 'esp');
        });

        test('přírůstkově: ptá se od posledního seq, rostoucí kus nahradí, nové přidá', async () => {
            api.log.length = 0;
            srv.add('tx', 'GET / HTT', 105);
            await view.refresh(api);
            assert.equal(rowsOf().length, 6);
            srv.grow('P/1.0\r\n');
            srv.add('rx', 'SEND OK\r\n', 106);
            await view.refresh(api);
            const rows = rowsOf();
            assert.equal(rows.length, 7);
            assert.equal(dataOf(rows[5]), 'GET / HTTP/1.0↵');
            assert.ok(rows[6].classList.contains('ok'));
            const sinces = api.log.filter(([c]) => c === 'espLog').map(([, a]) => a.since);
            assert.deepEqual(sinces, [5, 6]);
        });

        test('filtr, Hex a rozbalení dlouhého řádku', async () => {
            const input = findAll(root, (e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'text')[0];
            input.value = 'cipstart';
            input.fire('input');
            assert.deepEqual(rowsOf().filter((r) => !r.classList.contains('hidden')).length, 1);
            input.value = '';
            input.fire('input');
            assert.equal(rowsOf().filter((r) => r.classList.contains('hidden')).length, 0);
            const hexBox = findAll(root, (e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0];
            hexBox.checked = true;
            hexBox.fire('change');
            assert.equal(dataOf(rowsOf()[0]), '41 54 0D 0A');
            hexBox.checked = false;
            hexBox.fire('change');
            srv.add('rx', '+IPD,300:' + 'y'.repeat(300), 107);
            await view.refresh(api);
            const long = rowsOf()[7];
            assert.ok(long.classList.contains('long'));
            assert.ok(dataOf(long).includes(T('esp.more', 300 - 160)));
            long.fire('click');
            assert.ok(!dataOf(long).includes('…'));
            assert.ok(dataOf(long).endsWith('y'.repeat(20)));
        });

        test('Vymazat: espClear, nové epoch → prázdný pohled; nové sezení (jiné epoch) začne znovu', async () => {
            const clear = findAll(root, (e) => e.tagName === 'BUTTON' && e.textContent === T('esp.clear'))[0];
            clear.fire('click');
            for (let i = 0; i < 5; i++) await tick();
            assert.ok(api.log.some(([c]) => c === 'espClear'));
            assert.equal(rowsOf().length, 0);
            assert.ok(!findAll(root, byClass('esp-empty'))[0].hidden);
            srv.add('tx', 'AT+RST\r\n', 200);
            await view.refresh(api);
            assert.equal(rowsOf().length, 1);
            // jiný proces serveru: seq znovu od 1, jiné epoch
            srv.epoch = 1000;
            srv.log = [];
            srv.nextSeq = 1;
            srv.add('tx', 'AT\r\n', 1);
            await view.refresh(api);
            assert.deepEqual(rowsOf().map(dataOf), ['AT↵']);
        });

        test('ESP vypnuté: hláška se zapnutím v launch.json', async () => {
            srv.state = { enabled: false };
            srv.log = [];
            await view.refresh(api);
            const info = findAll(root, byClass('esp-info'))[0].textContent;
            assert.equal(info, T('esp.disabled'));
            assert.equal(findAll(root, byClass('esp-empty'))[0].textContent, T('esp.emptyDisabled'));
            checkTexts(domStrings(root), lang, AREAS, 'esp');
        });
    });
}
