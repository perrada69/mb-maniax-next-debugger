# MB Maniax Next Debugger

*English version: [README.md](https://github.com/perrada69/mb-maniax-next-debugger/blob/main/extension/README.md) · Uživatelská příručka (PDF, česky a anglicky, se snímky) je součástí rozšíření: **MB Maniax: Otevřít uživatelskou příručku** (Ctrl+Shift+P).*

Emulátor a ladicí nástroj pro **ZX Spectrum Next** přímo ve VS Code. Program ze **sjasmplus** se
spustí v přesném emulátoru (jádro [JNEXT](https://github.com/jorgegv/jnext)) a ladí se ve
zdrojáku: krokování, breakpointy, registry, paměť – a obrazovka emulátoru v panelu vedle kódu.

## Co umí

- **Breakpointy ve zdrojáku** (podle souboru `--sld` ze sjasmplus, včetně 8K stránek Nextu).
- **Podmíněné breakpointy, které nezpomalují** – podmínku vyhodnocuje přímo emulátor:
  `A == 5`, `HL > $4000 and not ZF`, `mem[counter] == 3`, `nextreg[$50] == 10`, `FRAME > 100`.
  Návěští ze zdrojáku jdou psát přímo (`mem16[score]`).
- **Počet průchodů** (`3`, `>= 10`, `% 4`) a **logpointy** (`barva {A}, skóre {mem16[score]}`).
- **Breakpointy na události stroje** (panel Breakpoints): přerušení IM 1 / IM 2, NMI, zápis do
  NEXTREG (`REG == $50`), vstup/výstup na port (`PORT == $FE`), Copper, DMA, reset.
- **Watchpointy** – zastavení při čtení nebo zápisu paměti (Watch → Break on Value Change,
  nebo pravým tlačítkem na registr: paměť, na kterou ukazuje).
- **Krok zpět** (Step Back) – emulátor si pamatuje posledních 10 sekund. Zapíná se v launch.json
  (`"rewind": true`); stopa instrukcí emulaci zpomalí, u Nextu na 28 MHz asi o čtvrtinu.
- Krokování (Step In / Over / Out), zásobník volání s návěštími, registry a příznaky (lze měnit),
  stránky MMU, disassembler, prohlížeč a úprava paměti, výrazy v panelu Watch a při najetí myší.
- **Obrazovka emulátoru** v panelu VS Code se zvukem a klávesnicí.
- **Panel Next** s pohledy na hardware Nextu (sprity, palety, tilemapa, Copper, …).

## Panel Next

Otevře se tlačítkem v liště ladění, tlačítkem „Next“ v panelu s obrazovkou nebo příkazem
**MB Maniax: Panel Next (sprity, palety, …)**. Záložky: Sprity, Pattern RAM, Palety, Tilemapa,
Layer 2, Vrstvy, Copper, NEXTREG.

Zobrazená záložka se obnoví při každém zastavení stroje (breakpoint, krok, pauza) a tlačítkem
„Obnovit“. S přepínačem **Živě** se obnovuje i za běhu, dvakrát za sekundu. Vybraný sprite nebo
oblast se může zvýraznit přímo v obrazovce emulátoru.

## Rychlý začátek

1. Přeložte program se ladicími informacemi:
   ```sh
   sjasmplus --sld=hra.sld --fullpath hra.asm
   ```
2. Do `.vscode/launch.json`:
   ```json
   {
     "type": "mbx-next",
     "request": "launch",
     "name": "Ladit na ZX Spectrum Next",
     "program": "${workspaceFolder}/hra.nex",
     "sld": "${workspaceFolder}/hra.sld",
     "preLaunchTask": "sjasmplus"
   }
   ```
   (Bez launch.json stačí F5 nad otevřeným `.asm` – vezme se `.nex` a `.sld` stejného jména.)
3. F5. Program bez SD karty vidí přes esxDOS svou složku (data, uložené pozice).

## Jazyk podmínek

Celá čísla, `$FF` / `0xFF`, registry (`A`, `HL`, `IX`, `IXH`, `SP`, `AF'` …), příznaky, `IFF1`,
`IM`, návěští (i lokální, `main_loop.wait`), `mem[a]`, `mem16[a]`, `nextreg[r]`, `mmu[slot]`,
`stack[n]`, `FRAME`, `CYCLE`, rastrové čítače, operátory
`== != < > <= >= and or not & | ^ << >> + - * / %`. U událostí navíc: zápis do NEXTREG `REG`,
`VALUE`; port `PORT` (celá 16bitová adresa – pište `(PORT & $FF) == $FE`), `VALUE`; Copper `CPC`,
`CVC`, `HC_ULA`; DMA `SRC`, `DST`. U watchpointů `ADDR`.

## BREAK z CSpectu

`BREAK` z CSpectu zastaví program jako breakpoint. sjasmplus s `--zxnext=cspect` ho překládá jako
`FD 00`; funguje i starší `DD 01` z CSpectu a `ED FF` ze ZEsarUX. Stroj stojí hned za instrukcí
(PC = BREAK + 2). Vypíná se v launch.json:
`"magicBreakpoint": false`. Na skutečném hardwaru se `FD 00` provede jako NOP, ale `DD 01` jako
`LD BC,nn` a spolkne další dva bajty, takže ho nenechávejte ve výsledném programu.

## WPMEM, LOGPOINT a ASSERTION v komentářích

Zvláštní komentáře ve zdrojáku (stejná syntaxe jako v DeZogu) se stanou watchpointy, logpointy
a asercemi. sjasmplus je do SLD zapíše jen s `SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION`
ve zdrojáku:

```asm
    SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION
skore:  dw 0            ; WPMEM            – hlídá 1 bajt na „skore“ (čtení i zápis)
buffer: ds 16           ; WPMEM buffer,16,w – zastaví při zápisu do 16 bajtů
        ld a,(hl)
        cp 10           ; LOGPOINT přečteno ${A} z ${HL}
        jr nc,moc_velke ; ASSERTION A < 10 – zastaví, když výraz neplatí
```

`; WPMEM [adresa[,velikost[,přístup]]]` (bez adresy = adresa řádku, velikost 1, přístup `r`, `w`
nebo `rw`), `; LOGPOINT text ${výraz}` (vypíše text do Debug Console, `${…}` nahradí hodnotou),
`; ASSERTION výraz`. LOGPOINT a ASSERTION se vyhodnotí *před* instrukcí na svém řádku – dejte je
na řádek za instrukcí, jejíž výsledek kontrolují. Každý druh jde vypnout v launch.json: `"wpmem"`, `"logpoints"`,
`"assertions"` (výchozí `true`).

## Run to Cursor a Jump to Cursor

Když stroj stojí, klikněte pravým tlačítkem na řádek zdrojáku: **Run to Cursor** (Spustit ke
kurzoru) nechá program běžet, než na řádek dojde, **Jump to Cursor** (Přejít ke kurzoru) přesune
PC na řádek bez provedení kódu mezi.

## Poloha paprsku

Když se stroj zastaví, panel s obrazovkou ukáže, kde je paprsek: azurová čára přes aktuální řádek
a purpurová značka na sloupci, v liště panelu „Řádek Y, sloupec X“ (v obrazu 320 × 256 včetně
okraje; mimo obraz syrové čítače VC/HC). Za běhu se značka skryje. Tlačítko paprsku v liště panelu
s obrazovkou ji zapíná a vypíná.

## Přeložit a nahrát znovu

**MB Maniax: Přeložit a nahrát znovu** (tlačítko v liště ladění, při ladění Ctrl+Alt+F5) uloží
otevřené soubory, spustí `preLaunchTask` z ladicí konfigurace a – když se překlad povede – nahraje
nový program do běžícího sezení: načte nové SLD, breakpointy se přesunou na nové adresy svých
řádků, WPMEM / LOGPOINT / ASSERTION a návěští platí z nového překladu. Obrazovka i panel Next
zůstanou otevřené. Když překlad selže, ukáže se chyba a nic se nenahraje. S nastavením
`mbxNext.reloadOnSave` (výchozí vypnuto) se totéž stane po uložení zdrojáku v assembleru
z pracovního prostoru během ladění.

## Uložené stavy

Příkazy **MB Maniax: Uložit stav…** a **Obnovit stav…** (i tlačítka v liště ladění) drží až 8
pojmenovaných snímků celého stroje pro aktuální ladicí sezení. Stav se ukládá na konci snímku:
stojí-li stroj v pauze uprostřed snímku, nabídne se doběhnout na konec snímku a uložit tam.
**Exportovat stav do souboru…** / **Importovat stav ze souboru…** ukládají stav do souboru
`.mbxstate` – načíst ho jde jen ve stejné verzi rozšíření.

## Profiler

**MB Maniax: Spustit profiler** (nebo tlačítko v liště ladění) sčítá T-stavy strávené na každé
instrukci. Při každém zastavení stroje se výsledek ukáže v editorech se zdrojákem: šedý text za
koncem řádku (`1 234 T · 12,3 %` celku), pozadí od žluté po červenou podle ceny řádku vůči
nejdražšímu řádku a značky v posuvníku (přehled). **Zobrazit výsledky profileru** vypíše
nejdražší funkce (podle nejbližšího globálního návěští) – výběrem se přejde na zdroják.
**Přepnout živé obnovování profileru** obnovuje výsledky za běhu každou sekundu. **Zastavit
profiler** nechá poslední výsledky v editoru a nabídne **Zobrazit výsledky** (součet zůstane ve stavovém
řádku – kliknutím na něj nejdražší funkce zobrazíte znovu); **Vynulovat profiler** začne počítat od nuly
a obarvení odstraní.

## Jazyk rozhraní

Rozšíření mluví anglicky, česky, slovensky, španělsky, německy, francouzsky, italsky, polsky,
portugalsky (Brazílie), rusky, ukrajinsky, japonsky a čínsky (zjednodušeně). Jazyk určuje
nastavení **`mbxNext.language`**:

- `auto` (výchozí) – jazyk VS Code, pokud není angličtina, jinak jazyk systému, jinak angličtina;
- nebo kód jazyka: `en`, `cs`, `sk`, `es`, `de`, `fr`, `it`, `pl`, `pt-br`, `ru`, `uk`, `ja`, `zh-cn`.

Změna platí pro nové ladicí sezení; otevřené panely (obrazovka, panel Next) se přestaví. Názvy
příkazů a popisy v nastavení a v launch.json se řídí jazykem VS Code.

## Licence

GNU GPL 3 nebo novější. Jádro emulátoru JNEXT © Jorge González Villalonga (GPL 3).
ROM ZX Spectra 48K © Amstrad, která jejich šíření s emulátory povoluje. Vytváří
[MB Maniax](https://mb-maniax.cz).
