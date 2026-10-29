# MB Maniax Next Debugger

*Česká verze: [README.cs.md](https://github.com/perrada69/mb-maniax-next-debugger/blob/main/extension/README.cs.md) · The user manual (PDF, English and Czech, with screenshots) comes with the extension: **MB Maniax: Open User Manual** (Ctrl+Shift+P).*

A **ZX Spectrum Next** emulator and debugger right inside VS Code. A program built with
**sjasmplus** runs in an accurate emulator (the [JNEXT](https://github.com/jorgegv/jnext) core) and
you debug it in its source: stepping, breakpoints, registers, memory – and the emulator screen in
a panel next to your code.

## Features

- **Source breakpoints** (from the sjasmplus `--sld` file, including the Next's 8K pages).
- **Conditional breakpoints with no slowdown** – the condition is evaluated by the emulator itself:
  `A == 5`, `HL > $4000 and not ZF`, `mem[counter] == 3`, `nextreg[$50] == 10`, `FRAME > 100`.
  Labels from the source can be used directly (`mem16[score]`).
- **Hit counts** (`3`, `>= 10`, `% 4`) and **logpoints** (`colour {A}, score {mem16[score]}`).
- **Machine event breakpoints** (Breakpoints view): IM 1 / IM 2 interrupts, NMI, NEXTREG writes
  (`REG == $50`), port input/output (`PORT == $FE`), Copper, DMA, reset.
- **Watchpoints** – stop on a memory read or write (Watch → Break on Value Change, or right-click
  a register: the memory it points to).
- **Step Back** – the emulator remembers the last 10 seconds. Enable it in launch.json
  (`"rewind": true`); the instruction trace slows emulation down by about a quarter on a Next at
  28 MHz.
- Stepping (Step Into / Over / Out), call stack with labels, registers and flags (editable),
  MMU pages, disassembly, memory viewer and editor, expressions in the Watch view and on hover.
- **Emulator screen** in a VS Code panel, with sound and keyboard.
- **Kempston mouse** – when the program reads the mouse, clicking the screen captures it; left
  Ctrl + left Alt or Esc releases it.
- **Next panel** with views of the Next hardware (sprites, palettes, tilemap, Copper, …).
- **Start into NextZXOS** – boot the real NextZXOS and debug the program it starts (NextZXOS is
  downloaded from specnext.com on request, it is not part of the debugger).
- **WiFi** – the emulated ESP-01 module on UART 0 opens real network connections, so network
  programs (mail, IRC, HTTP) can be debugged against servers on your LAN or the internet.

## Next panel

Open it with the button on the debug toolbar, the "Next" button in the screen panel, or the
command **MB Maniax: Next Panel (Sprites, Palettes, …)**. Tabs: Sprites, Pattern RAM, Palettes,
Tilemap, Layer 2, Layers, Copper, NEXTREG.

The visible tab is refreshed every time the machine stops (breakpoint, step, pause) and with the
Refresh button. With the **Live** switch it is also refreshed while running, twice a second. The
selected sprite or area can be highlighted right on the emulator screen.

## Quick start

1. Build the program with debug information:
   ```sh
   sjasmplus --sld=game.sld --fullpath game.asm
   ```
2. Add to `.vscode/launch.json`:
   ```json
   {
     "type": "mbx-next",
     "request": "launch",
     "name": "Debug on ZX Spectrum Next",
     "program": "${workspaceFolder}/game.nex",
     "sld": "${workspaceFolder}/game.sld",
     "preLaunchTask": "sjasmplus"
   }
   ```
   (Without a launch.json, just press F5 with an `.asm` file open – the `.nex` and `.sld` of the
   same name are used.)
3. Press F5. Without an SD card, the program sees its own folder through esxDOS (data, saved
   games).

## Start into NextZXOS

With `"boot": "nextzxos"` in launch.json the emulator boots the real NextZXOS from an SD card and
NextZXOS starts your program, as on a real Next – with the Browser, the NextZXOS esxDOS and
everything else NextZXOS offers:

```json
{
  "type": "mbx-next",
  "request": "launch",
  "name": "Debug via NextZXOS",
  "program": "${workspaceFolder}/game.nex",
  "sld": "${workspaceFolder}/game.sld",
  "boot": "nextzxos"
}
```

- Before booting, the program and its folder (`esxdosRoot`, default: the program's folder) are
  copied to `/MBX/<program name>` on the card (`cardFolder` changes it) and the card's
  autoexec.bas starts the program there. The debugger stops on the program's first instruction;
  breakpoints apply from then on. With `"autorun": false` NextZXOS opens the Browser in that
  folder and the debugger stops when you start the program yourself.
- With `"syncBack": true` the files the program created or changed on the card are copied back to
  its folder when the session ends (files deleted on the card are only listed).
- **NextZXOS is not part of the debugger.** Without `sdImage` the debugger uses a working card made
  from the official distribution for emulators, which it downloads from
  [specnext.com](https://www.specnext.com/latestdistro/) only when you ask (command
  **MB Maniax: Download NextZXOS**, or the question on the first start into NextZXOS) and after you
  agree to its license. It is kept only in the extension's data (about 2 GB) and checked by size
  and SHA-256.
- The working card is shared by all projects. **MB Maniax: Clean NextZXOS Working Card (/MBX)**
  deletes the programs' folders on it, **MB Maniax: Reset NextZXOS Working Card** returns the whole
  card to its downloaded state, and the setting `mbxNext.nextzxos.cardReset` set to
  `afterSession` does that after every session.

## WiFi (ESP-01)

With `"esp": true` in launch.json the program gets the Next's WiFi module: an emulated ESP-01 on
UART 0 (AT commands through ports $133B/$143B) that opens real TCP/UDP connections from your
computer. It is off by default – without it nothing answers on UART 0.

```json
{
  "type": "mbx-next",
  "request": "launch",
  "name": "Debug with WiFi",
  "program": "${workspaceFolder}/mail.nex",
  "sld": "${workspaceFolder}/mail.sld",
  "esp": true,
  "espAllowedHosts": ["192.168.1.10", "mail.example.org"]
}
```

- `espAllowedHosts` – the only hosts the program may connect to, exactly as it writes them in
  `AT+CIPSTART`; without it, any host.
- **Loopback (127.0.0.1, `localhost`) is always refused.** Servers on your LAN are allowed, so to
  reach a test server on this computer, start it on all interfaces (e.g. `php -S 0.0.0.0:8080`)
  and let the program connect to the computer's LAN address (192.168.x.x).
- The module is already joined to a WiFi network (`AT+CWJAP?` answers `+CWJAP:"JNextWifiHost",…`),
  so a program's usual connect sequence passes. `AT+CIPSTART` over TCP answers just `OK` (no
  `CONNECT` line) – wait for `OK` / `ERROR`.
- `espListenAddress` (default 127.0.0.1) – where `AT+CIPSERVER` listens; `espIpAddress` – the
  address the module reports to the program (`AT+CIFSR`), default 192.168.1.50.
- Works with the start into NextZXOS too. Step Back does not undo network traffic.

**Debugging the traffic.** The **WiFi (ESP)** tab of the Next panel shows everything the program
sent to the module and everything the module answered, line by line with the frame number – AT
commands, `OK` / `ERROR`, `+IPD` data – plus the module's state and its latest connections (opened,
closed, refused). Filter, hex view, Clear and Copy are on its toolbar; turn on **Live** to watch
it while the program runs. In the Breakpoints view, **ESP: line sent (Z80 → ESP)** and **ESP: line
received (ESP → Z80)** stop the program on the `OUT` / `IN` instruction that completed a matching
line; the condition is text in the line (`CIPSTART`) or a `/regex/`, empty stops on every line.

## Condition language

Integers, `$FF` / `0xFF`, registers (`A`, `HL`, `IX`, `IXH`, `SP`, `AF'` …), flags, `IFF1`,
`IM`, labels (also local ones, `main_loop.wait`), `mem[a]`, `mem16[a]`, `nextreg[r]`, `mmu[slot]`,
`stack[n]`, `FRAME`, `CYCLE`, raster counters, operators
`== != < > <= >= and or not & | ^ << >> + - * / %`. Event breakpoints also have: NEXTREG write
`REG`, `VALUE`; port `PORT` (the full 16-bit address – use `(PORT & $FF) == $FE`), `VALUE`; Copper
`CPC`, `CVC`, `HC_ULA`; DMA `SRC`, `DST`. Watchpoints have `ADDR`.

## CSpect BREAK

`BREAK` from CSpect stops the program like a breakpoint. sjasmplus with `--zxnext=cspect`
assembles it as `FD 00`; the older CSpect `DD 01` and `ED FF` from ZEsarUX also work. The machine
stops just after the instruction (PC = BREAK + 2). Turn it off with `"magicBreakpoint": false` in launch.json.
On real hardware `FD 00` runs as a NOP, but `DD 01` runs as `LD BC,nn` and swallows the next two
bytes, so don't leave it in release builds.

## WPMEM, LOGPOINT and ASSERTION in comments

Special comments in the source (the same syntax as in DeZog) become watchpoints, logpoints and
assertions. sjasmplus only writes them into the SLD file with
`SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION` in the source:

```asm
    SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION
score:  dw 0            ; WPMEM            – watch the 1 byte at "score" (read and write)
buffer: ds 16           ; WPMEM buffer,16,w – stop on a write into the 16 bytes
        ld a,(hl)
        cp 10           ; LOGPOINT read ${A} from ${HL}
        jr nc,too_big   ; ASSERTION A < 10 – stop when the expression is false
```

`; WPMEM [addr[,size[,access]]]` (no address = the address of the line, size 1, access `r`, `w`
or `rw`), `; LOGPOINT text ${expression}` (prints the text to the Debug Console, `${…}` is replaced
by the value), `; ASSERTION expression`. LOGPOINT and ASSERTION are evaluated *before* the
instruction on their line – put them on the line after the instruction whose result they check. Each kind can be turned off in launch.json:
`"wpmem"`, `"logpoints"`, `"assertions"` (all `true` by default).

## Run to Cursor and Jump to Cursor

While the machine is stopped, right-click a source line: **Run to Cursor** runs the program until
it gets to that line, **Jump to Cursor** moves PC to the line without running the code in between.

## Beam position

When the machine stops, the screen panel shows where the beam is: a cyan line across the current
row and a magenta mark at the column, plus "Line Y, column X" in the panel's bar (in the 320 × 256
picture including the border; outside the picture the raw counters VC/HC). While running the mark
is hidden. The beam button in the bar of the screen panel turns it on and off.

## Rebuild and Reload

**MB Maniax: Rebuild and Reload** (button on the debug toolbar, Ctrl+Alt+F5 while debugging) saves
open files, runs the `preLaunchTask` of the debug configuration and – if the build succeeds –
loads the new program into the running session: the new SLD is read, breakpoints move to the
new addresses of their lines, WPMEM / LOGPOINT / ASSERTION and labels are taken from the new
build. The screen and the Next panel stay open. When the build fails, an error is shown and
nothing is loaded. With the setting `mbxNext.reloadOnSave` (default off) the same happens
after saving an assembler source from the workspace during debugging.

## Saved states

Commands **MB Maniax: Save State…** and **Restore State…** (also buttons on the debug toolbar)
keep up to 8 named snapshots of the whole machine for the current debug session. A state is saved
at the end of a frame: if the machine is paused in the middle of a frame, you are offered to run to
the end of the frame and save there. **Export State to File…** / **Import State from File…**
store a state in a `.mbxstate` file – it can only be loaded by the same version of the extension.

## Profiler

**MB Maniax: Start Profiler** (or the button on the debug toolbar) counts the T-states spent on
every instruction. Whenever the machine stops, the source editors show the result: grey text at
the end of each line (`1,234 T · 12.3 %` of the total), a background from yellow to red by the
line's cost relative to the most expensive line, and marks in the scroll bar (overview ruler).
**Show Profiler Results** lists the most expensive functions (by the nearest global label) –
pick one to jump to its source. **Toggle Live Profiler Updates** refreshes the results every
second while running. **Stop Profiler** keeps the last results in the editor and offers **Show Results** (the total stays
in the status bar – click it to see the most expensive functions again); **Clear Profiler
Data** starts counting from zero and removes the colouring.

## Language

The extension is available in English, Czech, Slovak, Spanish, German, French, Italian, Polish,
Portuguese (Brazil), Russian, Ukrainian, Japanese and Simplified Chinese. The language is chosen
by the **`mbxNext.language`** setting:

- `auto` (default) – the VS Code display language if it is not English, otherwise the system
  language, otherwise English;
- or a language code: `en`, `cs`, `sk`, `es`, `de`, `fr`, `it`, `pl`, `pt-br`, `ru`, `uk`, `ja`,
  `zh-cn`.

A change takes effect with the next debug session; open panels (screen, Next panel) are rebuilt.
Command names and the descriptions in Settings and launch.json follow the VS Code display
language.

## License

GNU GPL 3 or later. JNEXT emulator core © Jorge González Villalonga (GPL 3).
ZX Spectrum 48K ROM © Amstrad, who allow it to be distributed with emulators. NextZXOS and the
System/Next distribution are not part of the debugger: they belong to their authors (NextZXOS
© Garry Lancaster) and are downloaded from specnext.com under their own license. Made by
[MB Maniax](https://mb-maniax.cz).
