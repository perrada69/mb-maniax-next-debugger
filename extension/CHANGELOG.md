# Changelog

## 0.2.0

- The user manual (PDF, English and Czech, with screenshots) is now part of the extension:
  command **MB Maniax: Open User Manual** opens it in your PDF viewer, in the extension's
  language (Czech also for Slovak, English otherwise).

## 0.1.0

First public release.

- ZX Spectrum Next emulator (JNEXT core) and debugger in VS Code, debugging in sjasmplus source
  through the SLD file, including the Next's 8K pages.
- Breakpoints with conditions evaluated by the emulator (no slowdown), hit counts, logpoints,
  machine event breakpoints (interrupts, NMI, NEXTREG, ports, Copper, DMA, reset), watchpoints.
- Stepping, Run to Cursor and Jump to Cursor, call stack with labels, registers and flags,
  MMU pages, disassembly, memory dump `m` in the Debug Console, expressions in Watch and on hover.
- CSpect `BREAK` (FD 00 / DD 01) and ZEsarUX ED FF; sjasmplus comment keywords WPMEM, LOGPOINT
  and ASSERTION.
- Emulator screen with sound and keyboard; beam position shown when the machine stops.
- Next panel: Sprites, Pattern RAM, Palettes, Layers, Layer 2, Tilemap, Copper, NEXTREG, Memory,
  Memory map and Sound, refreshed on every stop or live.
- Saved states (in memory and to a file), profiler with T-states per source line and the most
  expensive functions, Step Back (optional).
- Rebuild and Reload without ending the debug session (optionally on save).
- 13 languages: English, Czech, Slovak, Spanish, German, French, Italian, Polish, Portuguese
  (Brazil), Russian, Ukrainian, Japanese and Simplified Chinese.
- Windows x64.
