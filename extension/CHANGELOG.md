# Changelog

## 0.4.0

- **WiFi**: with `"esp": true` in launch.json the program gets the Next's ESP-01 WiFi module on
  UART 0 (emulated by the JNEXT core), which opens real TCP/UDP connections from your computer –
  network programs such as mail or IRC clients can be debugged against real servers.
  `espAllowedHosts` limits where the program may connect, `espListenAddress` sets where
  `AT+CIPSERVER` listens and `espIpAddress` the address the module reports. Loopback
  (127.0.0.1, localhost) is always refused; reach a server on your own computer through its LAN
  address. Off by default; works with the start into NextZXOS too.
- **ESP debugging**: the new **WiFi (ESP)** tab of the Next panel logs the traffic between the
  program and the module line by line (AT commands, replies, `+IPD` data, with frame numbers;
  filter, hex view, clear, copy) and shows the module's state and latest connections. New event
  breakpoints **ESP: line sent** / **ESP: line received** stop on the `OUT` / `IN` instruction that
  completed a line matching a text or `/regex/`.

## 0.3.0

- **Start into NextZXOS**: with `"boot": "nextzxos"` in launch.json the emulator boots the real
  NextZXOS from an SD card and NextZXOS starts the program (the program and its folder are copied
  to the card first). The debugger stops on the program's first instruction and sets breakpoints
  from then on. `"autorun": false` opens the Browser instead; `"syncBack": true` copies the files
  the program created or changed on the card back to its folder after the session.
- NextZXOS is not part of the debugger: command **MB Maniax: Download NextZXOS** (or the question on
  the first start into NextZXOS) downloads the official distribution for emulators from
  specnext.com after you agree to its license, checks its size and SHA-256 and keeps it only in the
  extension's data. One working card serves all projects; **Reset NextZXOS Working Card** and
  **Clean NextZXOS Working Card (/MBX)** keep it tidy, and `mbxNext.nextzxos.cardReset` can reset it
  after every session.

## 0.2.3

- esxDOS in the program's folder: a program can now delete files (also by wildcard, such as
  `*.TMP`), rename and move them, truncate them, create and remove folders and set the
  read-only attribute (F_UNLINK, F_RENAME, F_TRUNCATE, F_FTRUNCATE, F_MKDIR, F_RMDIR, F_CHMOD),
  and M_GETERR returns NextZXOS's error texts. Answers and error codes were measured on
  NextZXOS. Before, these calls failed with "Not implemented" and, for example, temporary files
  were left behind. As with writing, the changes go to disk at once and Step Back does not undo
  them.
- A short name such as `LONGNA~1.TXT` now always reaches the file shown under that name in the
  folder listing (on Windows it could reach another file through NTFS's own short name).

## 0.2.2

- A program that triggers a hard reset itself (NEXTREG $02) is loaded again, as on the Android
  app; before, the machine stayed stuck in the ROM without the program.

## 0.2.1

- User manual: the VS Code overview screenshot (figure 2) now shows the numbers 1–7 that its
  legend refers to.

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
