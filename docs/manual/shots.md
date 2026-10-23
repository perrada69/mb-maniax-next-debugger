# Snímky pro manuál

Soubory: `docs/manual/img/<jazyk>/<jméno>.png`, jazyk `cs` a `en` (texty rozšíření v daném jazyce,
nastavení `mbxNext.language`; samotné VS Code je v obou anglicky). Šířka okna VS Code 1600 × 1000,
PNG bez ztráty. Ořezy (`*-crop`) jsou výřezy z větších snímků.

| jméno | co je vidět | program |
| --- | --- | --- |
| `debug-overview` | celé okno: editor se žlutým řádkem na breakpointu, vlevo Variables (Registry rozbalené), Call Stack, Breakpoints, nahoře lišta ladění, vpravo panel obrazovky emulátoru | hello |
| `variables-crop` | výřez panelu Variables: registry, příznaky, Stroj (MMU, čas) | hello |
| `breakpoints-view` | sekce Breakpoints: breakpoint s podmínkou (`A == 3`), logpoint, zaškrtnuté filtry událostí (Přerušení…) | hello |
| `watch-view` | sekce Watch s výrazy `mem[counter]`, `HL`, `nextreg[$07]` | hello |
| `debug-console` | Debug Console s výpisem `m start` a výsledkem výrazu `A` | hello |
| `screen-panel` | panel obrazovky (ZX Spectrum Next) s lištou (⏸, zvuk, Next, stav snímků/s) | Best Time |
| `next-panel-vscode` | panel Next uvnitř VS Code vedle zdrojáku, záložka Sprity | Best Time |
| `next-sprites` … `next-nextreg` | 8 záložek panelu Next (`next-sprites`, `next-patterns`, `next-palettes`, `next-layers`, `next-layer2`, `next-tilemap`, `next-copper`, `next-nextreg`) | Best Time (závod) |
| `keywords-stop` | zastavení na ASSERTION: popis v Call Stack, výpis LOGPOINT v Debug Console, zdroják s komentáři | examples/features |
| `break-stop` | zastavení na BREAK (žlutý řádek na `BREAK`, důvod v Call Stack) | examples/features |
| `profiler-editor` | zdroják Best Time s anotacemi profileru (T-stavy za řádky, barevné pozadí), stavový řádek „Profiler“ | Best Time (závod) |
| `profiler-top` | QuickPick „nejdražší funkce“ | Best Time |
| `save-state` | InputBox uložení stavu | Best Time |
| `restore-state` | QuickPick obnovení stavu se 2–3 stavy | Best Time |
| `settings-language` | Nastavení filtrované na `mbxNext` (jazyk, cesta k serveru) | – |
| `launch-json` | editor s `.vscode/launch.json` konfigurací mbx-next | hello |
