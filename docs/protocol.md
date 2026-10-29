# Protokol rozšíření ↔ ladicí server

Rozšíření spouští `mbx-next-server` jako podproces a mluví s ním přes stdin/stdout. Výpisy
serveru (JNEXT) jdou na stderr.

## Rámce

`[u32 délka][u8 typ][data]`, délka = 1 + délka dat, little endian.

| typ | směr | obsah |
| --- | --- | --- |
| 1 | oba | JSON (UTF-8) |
| 2 | server → | obraz: u16 šířka, u16 výška, pixely RGBA (posílá se, jen když se změnil) |
| 3 | server → | zvuk: int16 stereo, 44,1 kHz (asi 882 vzorků za snímek) |

## Příkazy (JSON od rozšíření)

`{"cmd": "...", "id": 7, ...}` – s `id` přijde odpověď `{"id": 7, "ok": true, ...}` nebo
`{"id": 7, "ok": false, "error": "..."}`; bez `id` se neodpovídá (klávesy, myš).

| příkaz | argumenty | odpověď |
| --- | --- | --- |
| `hello` | | `version` |
| `launch` | `program`, `machine`, `sdImage`, `esxdosRoot`, `rom`, `stopOnEntry`, `rewind`, `magicBreakpoint` (výchozí true); start do NextZXOS: `boot` ("nextzxos"), `cardFolder`, `autorun` (výchozí true), `syncBack` (výchozí false); WiFi: `esp` (výchozí false), `espAllowedHosts`, `espListenAddress`, `espIpAddress` – viz níže | při `boot` "nextzxos": `waitsForNextZXOS` (vstup programu se hlídá) |
| `endSession` | | start do NextZXOS: `copied`, `missing` (cesty relativně ke složce), `folder` – viz níže |
| `prepareSd` | `zip`, `sdImage` | pracovní karta ze zipu distribuce – viz níže |
| `cleanCard` | `sdImage`, `folder` (výchozí /MBX) | |
| `pause`, `continue`, `stepIn`, `stepOver`, `stepOut`, `runToEndOfFrame` | | |
| `stepBack` | `count` | |
| `runTo` | `addr` | |
| `reset` | `hard` | |
| `state` | | `paused`, `pc`, `frame`, `tstates`, `cycleInFrame`, `mouse` {x, y, buttons, wheel, reads} |
| `registers` | | `registers` {AF … PC, I, R, IFF1, IFF2, IM, halted} + `state` |
| `setRegister` | `name`, `value` | |
| `readMemory` | `addr`, `length`, `page`? | `data` (base64); bez `page` paměť CPU, `length` nejvýš 0x10000; s `page` fyzická 8K stránka, `length` až 0x30000 souvisle přes stránky `page`, `page`+1, … (`addr` ≥ 0x2000 posune začátek do další stránky); stránka ≥ 0xE0 → chyba `invalid_page` |
| `writeMemory` | `addr`, `data` (base64), `page`? | `written` |
| `disassemble` | `addr`, `count` | `lines` [{addr, bytes, text}] |
| `callStack` | | `frames` [{caller, target, sp, type}] (poslední = nejvnitřnější) |
| `mmu` | | `slots` [{nr, page}] |
| `nextregs` | | `data` (256 B, base64), `clips` {`layer2`, `sprites`, `ula`, `tilemap`: {`x1`, `x2`, `y1`, `y2`}} – celá ořezová okna (NR $18/$19/$1A/$1B čtou jen jednu souřadnici) |
| `sprites` | | `sprites` [128 × {x, y, pattern, paletteOffset, visible, xMirror, yMirror, rotate, is4bit, xScale, yScale, relative, anchor}], `attrs` (base64, 128 × 5 B), `clip` {x1, x2, y1, y2} – viz níže |
| `patternRam` | | `data` (base64, 16384 B) |
| `palettes` | | `banks` {ula0, ula1, layer2_0, layer2_1, sprite0, sprite1, tilemap0, tilemap1: 256 × RGB333}, `activeUla` (0/1) |
| `copper` | | `pc` (0–1023), `running`, `mode` (0–3), `program` (base64, 1024 × u16 LE) |
| `renderLayer` | `layer`: composite, ula, ulaShadow, layer2, layer2Shadow, sprites, tilemap, background | `width` (640), `height` (256), `data` (base64 RGBA) |
| `raster` | | `vc`, `hc`, `x`, `y`, `frame`, `cycleInFrame`, `linesPerFrame` – viz níže |
| `soundState` | | `chips` [3 × {`regs`: 16 čísel}], `turbosound`, `ayMode` (AY / YM / reset), `dac` [4 čísla] nebo null |
| `pageUsage` | | `nonzero` [224 čísel], `rom` [] |
| `evaluate` | `expr` | `value` |
| `loadSymbols` | `path` (řádky `JMÉNO = $ADRESA`) | `count` |
| `setBreakpoints` | `breakpoints` [{id, addr, page?, condition?, hitCondition?, logMessage?}] | `breakpoints` [{id, verified, message?}] |
| `setWatchpoints` | `watchpoints` [{id, addr, length, access: read/write/readWrite, condition?}] | `watchpoints` |
| `setEventBreakpoints` | `events` [{id, kind, condition?, …}] – kind: interrupt, nmi, nextreg (`regs`), port (`mask`, `value`, `access`), scanline (`line`), frame, copper, dma, reset, espTx, espRx (`condition` = vzor řádku, viz WiFi) | `events` |
| `espLog` | `since` (seq, výchozí 0), `max` (výchozí 2000) | `enabled`, `epoch`, `first`, `next`, `bytesTx`, `bytesRx`, `entries` [{seq, dir: tx/rx, frame, t, data (base64)}] – viz WiFi |
| `espState` | | `enabled`; se zapnutým ESP i `associated`, `stationIp`, `allowedHosts`, `listenAddress`, `events` [{kind, host, port, detail}], `eventsTotal` |
| `espClear` | | |
| `key` | `scancode` (SDL), `down` | – |
| `releaseKeys` | | – |
| `joy` | `bits` (Kempston: R L D U F1 F2) | – |
| `mouse` | `dx`, `dy` (dy > 0 = dolů), `buttons` (bit 0 levé, 1 pravé, 2 prostřední), `wheel` (kroky, + = od sebe) | – |
| `audio` | `on` | |
| `screen` | (pošli obraz znovu) | |
| `stateSave` | `name`, `advance`? | – (chyby `notAtFrameBoundary`, `limit`) |
| `stateRestore` | `name` | – (chyba `notFound`) |
| `stateList` | | `names` [..] (v pořadí uložení) |
| `stateExport` | `advance`? | `data` (base64), `size` (chyba `notAtFrameBoundary`) |
| `stateImport` | `data` (base64) | – (chyba `incompatible`) |
| `profilerStart` | | `active` |
| `profilerStop` | | |
| `profilerClear` | | (`active`, pokud běží) |
| `profilerState` | | `active` |
| `profilerData` | `format`? (`json` výchozí, `binary`) | `active`, `total`, `count`, `entries` [{page, offset, pc, t}] nebo `data` (base64) |
| `quit` | | |

Každý seznam breakpointů (`setBreakpoints`, `setWatchpoints`, `setEventBreakpoints`) nahrazuje
předchozí seznam stejného druhu. Podmínky jsou v jazyce výrazů JNEXT (`script/expr_compiler.h`).

### Hardware Nextu (panel „Next“, docs/next-views.md)

`sprites`, `patternRam`, `palettes`, `copper`, `renderLayer` jen čtou a fungují za běhu i v pauze
(za běhu mezi snímky).

**`sprites`** – pořadí 0–127. `x`, `y` jsou 9bitové (0–511) v prostoru 320 × 256 včetně okraje
(x 0 = levý okraj, y 0 = horní okraj; na obraze 640 × 256 je x zdvojené). Rozměr spritu je
16 << `xScale` × 16 << `yScale` (scale 0–3 = 1×, 2×, 4×, 8×).
- `pattern` je číslo vzoru, které hardware čte: u 8bitového spritu (`is4bit` false) N5:N0 (0–63),
  vzor = 256 B od `pattern × 256`; u 4bitového N5:N0:N6 (0–127), vzor = 128 B od `pattern × 128`
  (dva pixely v bajtu, horní nibble vlevo). Barva = paleta spritů [(`paletteOffset` << 4) + nibble]
  u 4bitových, u 8bitových [(`paletteOffset` << 4) + bajt] & 0xFF.
- Relativní sprity (`relative` true; rozšířený sprite s atributem 4 bity 7–6 = 01) jsou už
  rozvedené ke kotvě: x, y, pattern, paletteOffset, zrcadlení, rotace, is4bit, zvětšení
  a visible jsou výsledné hodnoty, jak je kreslí JNEXT (`SpriteEngine::resolve_relative`).
  `anchor` = index kotvy (posledního nerelativního spritu před ním), u ostatních −1. JNEXT sám
  (SpriteInfo) relativní sprity nerozvádí – x/y tam jsou syrové posuny – proto to dělá server.
- `attrs` jsou syrové atributy (5 B na sprite: X, Y, paleta/zrcadlení/rotace/X8, viditelnost/
  rozšíření/N5:N0, 4bit/N6/scale/Y8).
- `clip` jsou syrové hodnoty NR 0x19 (x1, x2, y1, y2); jak se uplatní (bez spritů přes okraj
  posun o 32, přes okraj s ořezem x × 2, přes okraj bez ořezu se nepoužije), záleží na NR 0x15.

**`palettes`** – RGB333 = 0–511, bity 8–6 R, 5–3 G, 2–0 B (tak je drží i JNEXT, nic se nepřevádí).
Priorita Layer 2 (NR 0x44 bit 7) v hodnotách není.

**`copper`** – `mode` = NR 0x62 bity 7–6 (0 stop, 1 start od 0, 2 pokračuje od `pc`, 3 od 0 a znovu v každém snímku);
`running` = mode ≠ 0. Slovo programu: bit 15 = 1 WAIT (bity 14–9 vodorovná pozice, 8–0 řádek),
bit 15 = 0 MOVE (bity 14–8 registr, 7–0 hodnota; 0x0000 = NOOP). Každé slovo jde jako u16
little endian (dolní bajt první).

**`renderLayer`** – kreslí JNEXT (`Debugger::render_layer`): celý snímek, řádky 0–255 (vc = 255),
s registry přehranými po řádcích jako při skládání obrazu (rozdělení rastru, Copper). Obraz má
stejné souřadnice jako rámec obrazu (640 × 256 = 320 × 256 zdvojené vodorovně). Pixely R, G, B, A;
alfa 0 = vrstva tam nic nekreslí (průhledné), `composite` a `background` jsou celé neprůhledné.
Zastaví-li se stroj uprostřed snímku, řádky pod paprskem jsou kreslené s aktuálním stavem
registrů (na obrazovce je tam ještě předchozí snímek). Odpověď má asi 870 kB.

### Paprsek, zvuk, paměť (docs/next-views.md, „Doplňky“)

`raster`, `soundState`, `pageUsage` jen čtou a fungují za běhu i v pauze (za běhu mezi snímky –
paprsek tam stojí na začátku snímku, vc 0).

**`raster`** (`Debugger::raster()`, `machine()`, `time()`):
- `vc`, `hc` – syrové čítače VHDL (`RasterState::raw_vc`/`raw_hc`): 0 = levý horní roh celého
  snímku včetně zatemnění, `hc` v tikách 7 MHz (Next 50 Hz: 456 na řádek, 311 řádků).
- `x`, `y` – kde paprsek kreslí v prostoru 320 × 256 (= rámec obrazu 640 × 256 / 2 vodorovně,
  stejný prostor jako sprity a `highlight`), přepočet jako při kreslení v JNEXT:
  `x = 32 + phc` (sloupec v rámci 640 je `DISP_X 64 + 2·phc`, video/renderer.cpp; `phc` = 0 na
  prvním pixelu papíru, záporné v levém okraji), `y = vc − vblank_top` (core/emulator.cpp, `fb_row`;
  `vblank_top` = c_min_vactive − 32, u Nextu 50 Hz 32, takže papír začíná na y 32 a vc 287 je y 255).
  Každá osa zvlášť je −1, když je mimo rámec (zatemnění, okraj, který obraz nezobrazuje) – `y`
  tak platí i během řádkového zatemnění, kdy je `x` −1.
- `frame` a `cycleInFrame` jako u `state` (cykly 28 MHz od začátku snímku, asi 4 × (vc × 456 + hc)),
  `linesPerFrame` = `MachineInfo::lines` (Next 50 Hz 311, 48K 312).

**`soundState`**:
- `chips` – registry R0–R15 tří AY (`ay_registers(0..2)`), čísla 0–255.
- `turbosound` – živý signál zapnutí TurboSoundu (NR 0x08 bit 1).
- `ayMode` – `"AY"` / `"YM"` (`ay_mode()`, NR 0x06 bit 0), `"reset"`, když NR 0x06 bity 1–0 = 11
  (všechny čipy drží v resetu; jen Next).
- `dac` – 8bitové kanály A, B, C, D DAC (Soundrive; na ně míří i porty Covox a Specdrum; 0x80 =
  ticho; A+B levý, C+D pravý kanál). `null`, když je DAC vypnutý (NR 0x08 bit 3) nebo ho stroj
  nemá (48K/128K/+3/Pentagon). JNEXT hodnoty nevystavuje getterem, server je čte ze stavu `Dac`.

**`pageUsage`** – `nonzero`[i] = počet nenulových bajtů (0–8192) v 8K stránce RAM i (číslování
NR 0x50–0x57, 0–223), čteno přes `peek(MemSpace::page)`; stránka, kterou nejde přečíst, má −1.
`rom` je vždy prázdné pole: ROM v tomto číslování neleží (u Nextu je v SRAM pod stránkou 0,
u ostatních strojů zvláštní obraz). Vyřízení: server 1–2 ms (224 × 8 KB = 1,8 MB, nezávisle na
obsahu), celé kolo s odpovědí v pauze kolem 5 ms, za běhu do 20 ms (čeká na konec snímku);
Best Time i hello.

### Start do NextZXOS

`launch` s `"boot": "nextzxos"` program nenahraje přímo: stroj nabootuje opravdový NextZXOS
z obrazu `sdImage` (nextboot.rom → TBBLUE.FW → NextZXOS) a program spustí NextZXOS.

- **Před bootem** server nahraje na kartu obsah složky `esxdosRoot` (výchozí: složka programu; bez
  skrytých položek a odkazů, jen jména ASCII) a program do `cardFolder` (výchozí
  `/MBX/<jméno programu>`; co tam je, přepíše) a zapíše `c:/nextzxos/autoexec.bas`: `.cd` do složky
  a `.nexload` programu, s `autorun` false `.browse` (Browser ve složce programu). Vlastní
  autoexec.bas karty odloží do `AUTOEXEC.MBX` a `endSession` (nebo `quit`, nebo příští `launch`)
  ho vrátí. Cesty v autoexecu jsou bez písmene jednotky: dvojtečka v řádku BASICu odděluje
  příkazy, takže `.cd c:/MBX` by dostal jen `c` (změřeno).
- **Vstup programu**: breakpoint na PC z hlavičky NEX s podmínkou na prvních 8 bajtů kódu (ze
  souboru) a stránku v $C000. Bajty jsou v paměti až po nahrání, takže kód NextZXOS na téže adrese
  podmínku nesplní; podmínku vyhodnocuje jádro a boot se nezpomalí. Zastavení přijde jako
  `stopped` s `reason` entry – rozšíření teprve pak pošle breakpointy, dřív by zastavovaly
  v NextZXOS. Bez autorunu přijde vstup, až program spustí uživatel v Browseru.
- esxDOS obsluhuje NextZXOS sám (`esxdosRoot` se nepřipojuje jako složka na disku).
- **`endSession`**: vrátí autoexec a se `syncBack` zkopíruje ze složky na kartě do `esxdosRoot`
  soubory, které jsou nové nebo se liší (`copied`); soubory, které na kartě chybějí, jen vypíše
  (`missing`), nic se nemaže. Program sám se nevrací, pokud neleží v `esxdosRoot`.
- **`prepareSd`**: z oficiálního zipu distribuce pro emulátory (sn-emulator-*.zip) vybalí
  `cspect-next-1gb.img`, upraví ho jako JNEXT (FAT32 s clustery 8 KB, config.ini) a vypne uvítací
  program (`AUTOEXEC.1ST` → `welcome.bas`, totéž dělá jeho volba „D“). Výsledek uloží do `sdImage`.
- **`cleanCard`**: smaže strom `folder` na kartě.
- Zápisy na kartu se při Step Back nevracejí (jako zápisy na disk přes esxDOS).

**NextZXOS není součástí debuggeru.** Distribuce System/Next (NextZXOS, firmware, ROM) patří svým
autorům a šíří se pod „The Next License“ (`LICENSE.md` v distribuci,
<https://gitlab.com/thesmog358/tbblue/-/raw/master/LICENSE.md>): smí se používat a předávat jen
celá a beze změny a nesmí se prodávat. Rozšíření ji proto nikdy nepřibaluje: stáhne ji až na pokyn
uživatele (příkaz **Stáhnout NextZXOS** nebo dotaz při prvním startu do NextZXOS) z
<https://www.specnext.com/distro/24.11/sn-emulator-24.11.zip> (System/Next 24.11, NextZXOS 2.09;
51 829 771 B, SHA-256 `b2b0cbfb421acba2dcd00b081e647d7ead7bd0bc35952f0fdcafe1581321b516` – otisk jsme
spočítali sami, specnext.com žádný nezveřejňuje), po souhlasu s licencí, a uloží ji jen do dat
rozšíření (globalStorage/nextzxos: zip, `base.img` po `prepareSd`, pracovní `card.img`). Upravuje se
jen uživatelova vlastní kopie, nic z ní se nikam nepředává. Nastavení `mbxNext.nextzxos.url`,
`sha256` a `size` jdou změnit (novější distribuce); stažený soubor, který nesouhlasí, se odmítne.

### WiFi (ESP-01)

`launch` s `"esp": true` připojí na UART 0 emulovaný modul ESP-01 z JNEXT (`src/esp01`, příkazy AT
v `esp_at.cpp`): program mluví s modulem přes porty $133B (zápis = vysílaný bajt, čtení = stav:
bit 0 přijatý bajt, bit 1 plný vysílač) a $143B (čtení = přijatý bajt) a modul otevírá skutečná
spojení TCP/UDP z počítače, na kterém server běží. Výchozí je vypnuto (`EmulatorConfig::esp_enabled`,
JNEXT ho z bezpečnostních důvodů sám nikdy nezapne) – bez něj na UART 0 nic neodpovídá.

| volba | výchozí | význam (`EmulatorConfig`) |
| --- | --- | --- |
| `esp` | false | zapne modul (`esp_enabled`) |
| `espAllowedHosts` | [] | jediné hosty, kam se program smí připojit (`esp_allowed_hosts`): jména nebo adresy přesně tak, jak je program píše v `AT+CIPSTART` (bez rozlišení velikosti písmen, bez zástupných znaků); prázdné = jakýkoli host. Prázdná položka → chyba launch. Platí i pro `AT+CIPDOMAIN`, `AT+PING` a SNTP. |
| `espListenAddress` | 127.0.0.1 | kde poslouchá `AT+CIPSERVER` (`esp_listen_address`); jen číselná adresa, jinak chyba launch. `0.0.0.0` zpřístupní emulovaný Next celé síti. |
| `espIpAddress` | 192.168.1.50 | adresa stanice, kterou modul hlásí (`AT+CIFSR`, `AT+CIPSTA?`; `esp_ip_address`), jen informativní – nic na ní neposlouchá; číselná a nenulová, jinak chyba launch. |

Bez `esp` se ostatní volby ignorují. Nastavení platí pro oba starty (přímé nahrání i `boot`
"nextzxos") a pro každý studený start v sezení (reset, nahrání programu, tvrdý reset vyvolaný
programem); nový `launch` bere nové.

- **Smyčka je zakázaná vždy**, i bez `espAllowedHosts` (`esp::AddressPolicy` v JNEXT): 127.0.0.0/8,
  `localhost`, ::1, link-local (169.254/16), adresy cloudových metadat, 0.0.0.0, multicast.
  **Soukromé sítě (10/8, 172.16/12, 192.168/16) povolené jsou** – na server na tomtéž počítači
  (např. `php -S 0.0.0.0:8080`) se program dostane přes adresu počítače v místní síti.
- Modul je od zapnutí „připojený“ k síti `JNextWifiHost` (`AT+CWJAP?` → `+CWJAP:"JNextWifiHost",…`,
  `AT+CWJAP="…","…"` přijme cokoli), takže sekvence skutečných programů (NextIRC, NXtel) projdou.
- Odlišnosti JNEXT od skutečného firmwaru, se kterými musí program počítat: `AT+CIPSTART` přes TCP
  odpoví jen `OK` (bez řádku `CONNECT`; UDP `CONNECT` posílá) – program má čekat na `OK`/`ERROR`,
  ne na `CONNECT`; `AT+CIPSEND` odpoví `OK` a `> `.
- Rychlost UART se řídí děličem (port $143B zápis / $153B); výchozí 115 200 Bd, `AT+UART_CUR`
  tempo mění podle skutečného děliče.
- Síť se při Step Back ani obnovení stavu nevrací (spojení běží dál mimo emulátor); v pauze modul
  data přijímá, program je dostane po rozběhnutí.
- Odmítnutá a neúspěšná spojení hlásí JNEXT varováním na stderr (`[esp01] [warning] REFUSED …`),
  rozšíření je ukáže v Debug Console.

#### Ladění provozu s modulem

Server vloží mezi UART 0 a adaptér ESP z JNEXT vlastní zařízení (`server/esp_tap.h`; jádro se
nemění, po každém studeném startu a nahrání programu se vloží znovu) a zaznamená každý bajt
oběma směry: **tx** = program → ESP (bajt opustil vysílač UART), **rx** = ESP → program (bajt
vstoupil do přijímací FIFO). Při přehrávání (Step Back, RZX) se nic nezapisuje – bajty tehdy na
síť nejdou.

- **`espLog`**: záznam po kusech – kus jsou souvislé bajty jedním směrem, končí `\n`, změnou směru
  nebo po 1024 bajtech. `seq` roste o 1 po celé sezení bez děr; `since` vrátí kusy se `seq ≥ since`.
  Poslední kus může ještě růst: klient se příště ptá od jeho `seq` a kus nahradí. `frame` a `t`
  (T-stavy od startu) patří prvnímu bajtu kusu. Záznam drží nejvýš 4 MB / 50 000 kusů (starší
  odpadají, `first` = nejstarší držený). `epoch` se mění při `espClear` a novém `launch` a liší se
  mezi procesy serveru – klient pak zahodí, co má. Reset záznam nemaže. `enabled` false = ESP
  vypnuté (záznam prázdný).
- **`espState`**: stav modulu z JNEXT – `associated` (připojený k síti), `stationIp`,
  `allowedHosts`, `listenAddress` a posledních až 32 událostí spojení (`kind`: opened, closed,
  refused, failed, transport fault; `host`, `port`, `detail`).
- **Breakpointy `espTx` / `espRx`** (`setEventBreakpoints`): server skládá řádky z bajtů, které
  program zapíše na port $133B (espTx), resp. přečte z $143B (espRx), jen s vybraným UART 0, a
  zastaví **instrukci OUT / IN, která řádek dokončila** (`\n`), když řádek bez `\r\n` odpovídá
  `condition`: prázdná = každý řádek, `/regex/` nebo `/regex/i` = regulární výraz (ECMAScript),
  jinak podřetězec bez ohledu na velikost písmen. Neplatný regex → `verified` false a `message`.
  Podmínka se nepřekládá jako výraz. Zastavení: `reason` event, `eventKind` espTx / espRx, `text`
  `Z80 → ESP: <řádek>` / `ESP → Z80: <řádek>` (řídicí znaky jako `\r`, `\xNN`).

### Magic breakpoint

Instrukce `BREAK` z CSpectu (`DD 01`; sjasmplus ji s `--zxnext=cspect` zná jako `BREAK`, jinak
`DB $DD,$01`) a `ED FF` (ZEsarUX) zastaví stroj, když je `magicBreakpoint` zapnutý (výchozí;
`launch` ho nastaví i do konfigurace studeného startu, takže přežije `reset` a nahrání programu).
Instrukce se provede jako dvoubajtový NOP (8 T) a stroj stojí **za ní** (PC = adresa BREAK + 2);
`stopped` má `reason` magic a `pc` je adresa následující instrukce. Pokračuje se normálně
(`continue`, kroky). Krok (`stepIn`/`stepOver`) přes BREAK hlásí také `reason` magic. Vypnutý
(`magicBreakpoint` false) se `DD 01` chová jako na skutečném Nextu (prefix DD před `LD BC,nn`,
spotřebuje další dva bajty).

### Uložené stavy

Celý stav stroje (paměť a podsystémy, u Nextu 2 154 296 B) jde uložit jen **na hranici snímku**.
Běžící stroj na ní stojí vždy (příkazy se vyřizují mezi snímky). Stroj zastavený uprostřed snímku
(breakpoint, krok) bez `advance` → `ok: false, error: "notAtFrameBoundary"`; s `advance: true` se
dojede na konec snímku (breakpointy se při tom nehlásí) a server pošle `stopped` s `reason`
frameBoundary (rozšíření obnoví registry, paměť, obraz). Totéž platí pro `stateExport`.

- `stateSave` – záložka pod jménem; stejné jméno přepíše. Nejvýš 8 záložek (limit JNEXT na
  klienta), deváté nové jméno → `error: "limit"`. Záložky žijí v paměti serveru (do konce
  ladění), přežijí `reset` i nové `launch`.
- `stateRestore` – neznámé jméno → `error: "notFound"`; jiný typ stroje → `refused_unavailable`.
  Po obnovení stroj **stojí** a přijde `stopped` s `reason` restore (běžel-li, server ho nejdřív
  zastaví; jiné zastavení se nehlásí). Obraz se překreslí až dalším snímkem.
- `stateExport` / `stateImport` – syrové bajty `Emulator::save_state` (bez hlavičky, mezi verzemi
  serveru nepřenosné). Import zkontroluje délku proti stavu tohoto stroje (jiný stroj →
  `error: "incompatible"`, nic se nezmění), jinak se chová jako `stateRestore`.

Obnovení nemění breakpointy, profiler ani nastavení serveru.

### Profiler

T-stavy CPU na fyzickou adresu (8K stránka + posun), `Emulator::profiler()` z JNEXT. Počítá každá
provedená instrukce – za běhu, v krocích, při `runToEndOfFrame` i při posunu na hranici snímku –
a to i HALT (každé opakování) a přijetí přerušení (připíše se instrukci, před kterou přišlo).
Nepočítá se doba, kdy sběrnici drží DMA (CPU stojí; u Best Time asi 0,7 % snímku). V pauze se
nic nepřičítá.

- `profilerStart` – zapne (alokuje 32 MB, čítače nulové); běží-li, nic.
- `profilerStop` – vypne a **data zahodí** (nejdřív si je stáhni přes `profilerData`).
- `profilerClear` – vynuluje čítače, profiler běží dál.
- Studený start (`reset` hard, `launch`) a nahrání programu čítače vynulují, profiler zůstane
  zapnutý.
- `profilerData` – jen nenulové položky, vzestupně podle fyzické adresy:
  `page` 0–255, `offset` 0–8191 (v 8K stránce), `pc` (poslední logická adresa, ze které se tam
  vykonávalo), `t` (T-stavy). `total` = součet `t`, `count` = počet položek. Neběží-li, `active`
  false a prázdná data. S `format: "binary"` místo `entries` přijde `data` (base64), 16 B na
  položku little endian: u8 page, u8 0, u16 offset, u16 pc, u16 0, u64 t. Best Time (asi 4 400
  položek po 3 s závodu): JSON 197 kB, binárně 79 kB, vyřízení kolem 20 ms.

## Události (JSON od serveru)

| událost | obsah |
| --- | --- |
| `ready` | `version` – server je připravený |
| `stopped` | `reason` (entry, breakpoint, step, pause, data breakpoint, goto, exception, event, magic, frameBoundary, restore), `eventKind` (jen u `reason` event: druh z `setEventBreakpoints` – interrupt, nmi, nextreg, port, …, espTx, espRx), `pc`, `ids` (breakpointy, které zastavily), `text` |
| `continued` | |
| `reset` | `hard` |
| `output` | `text` – logpointy, výpisy backendu; u hlášek serveru navíc `key` a `args` (viz níže) |
| `exited` | `code` |

### Texty pro uživatele

Server nic nepřekládá: `text` je vždy anglicky (s koncem řádku) a hlášky serveru mají vedle něj
`key` a `args` (pole řetězců), podle kterých je rozšíření přeloží (`session.ts`, `SERVER_TEXTS`
→ `l10n/session.json`). Neznámý `key` → rozšíření ukáže `text`. Logpointy a výpisy backendu
(JNEXT) `key` nemají a jdou tak, jak jsou. Breakpoint na událost hlásí `reason` event a druh
v `eventKind`; popisek důvodu (přeložený název filtru z panelu Breakpoints) dává rozšíření.

| `key` | `args` | `text` |
| --- | --- | --- |
| `loadFailed` | cesta k programu | `Failed to load the program: …` |
| `rewindFailed` | výsledek `resize_rewind_buffer`, `set_rewind_enabled` | `Cannot enable Step Back: … / …` |
| `conditionError` | text podmínky, chyba za běhu | `Condition "…": …` |
| `esxdosWritable` | složka esxDOS | `esxDOS works in the folder … with write access: the program's writes change files on disk immediately and Step Back cannot undo them.` |
| `cardStaged` | počet souborů, složka na kartě | `… file(s) copied to C:/MBX/… on the SD card; NextZXOS starts the program.` |
| `entryUnknown` | cesta k programu (a chyba) | `Cannot read … as a NEX file: …` – debugger vstup nepozná |
| `entryNone` | cesta k programu | `The NEX file has no start address (PC=0): …` |
| `cardFinishFailed` | chyba | `SD card: …` – autoexec karty se nepodařilo vrátit |
| `espEnabled` | | `Emulated ESP-01 WiFi on UART 0: the program can connect to any host. …` – `launch` s `esp` bez `espAllowedHosts` |
| `espEnabledHosts` | seznam hostů (oddělený „, “) | `Emulated ESP-01 WiFi on UART 0: the program can connect only to …. …` |

`esxdosWritable` je informace, ne chyba: přijde jednou za `launch`, když server bez SD karty
zpřístupní programu jeho složku přes esxDOS se zápisem (nahrazuje varování JNEXT
„--esxdos-stub-writable: …“, které chodilo při každém resetu a nahrání).

**Potlačené výpisy.** Server propouští výpisy JNEXT (stderr, úroveň warn a výš; rozšíření je ukazuje
v Debug Console) a řádky backendu (`output`) beze změny, kromě šumu, který při ladění přichází
při každém startu a resetu:
- `warm start: no SD image is mounted …` (error) – bez SD karty očekávané, ROM dává server sám;
- `--esxdos-stub-writable: …` (warning) – místo něj `esxdosWritable` výše;
- `MUTATE … by <klient serveru>` (`output`) – záznam backendu o změně, kterou udělal sám ladicí
  server (reset, nahrání programu, zápis do paměti a registrů, obnovení stavu); řádky
  s `FAILED` projdou.
Ostatní chyby a varování (např. `--esxdos-stub-root: …`, odmítnutá SD karta) jdou dál.

Chyby v odpovědích (`error`) a `message` u neověřených breakpointů jsou anglické kódy a hlášky
backendu (`dbg::result_name`, překladač výrazů JNEXT) a nepřekládají se.
