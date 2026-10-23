// Tabulka registrů NEXTREG pro pohledy (NEXTREG, Copper): jména, skupiny, přístup a rozpis bitů.
// Jména: JNEXT src/debugger/nextreg_panel.cpp (NextRegPanel::reg_name), doplněná podle dokumentace Nextu.
// Bity: podle čtecích/zápisových handlerů v JNEXT src/core/emulator.cpp (a peripheral/copper.cpp,
// video/*.cpp). Rozpis popisuje hodnotu při ČTENÍ (server posílá NextReg::peek = čtení bez vedlejších účinků).
(function () {
    // Jména přesně podle JNEXT (nextreg_panel.cpp:15–101).
    const JNEXT = {
        0x00: 'Machine ID', 0x01: 'Core Version', 0x02: 'Reset', 0x03: 'Machine Type',
        0x05: 'Peripheral 1', 0x06: 'Peripheral 2', 0x07: 'CPU Speed', 0x08: 'Peripheral 3',
        0x09: 'Peripheral 4', 0x0A: 'Peripheral 5', 0x0B: 'Joystick', 0x0E: 'Core Boot',
        0x10: 'Mouse Config', 0x11: 'Video Timing', 0x12: 'L2 Active Bank', 0x13: 'L2 Shadow Bank',
        0x14: 'Transparency Col', 0x15: 'Spr/Layer Prior', 0x16: 'L2 X Scroll LSB', 0x17: 'L2 Y Scroll',
        0x18: 'Clip L2', 0x19: 'Clip Sprite', 0x1A: 'Clip ULA', 0x1B: 'Clip Tilemap', 0x1C: 'Clip Control',
        0x1E: 'Line IRQ Ctrl', 0x1F: 'Line IRQ Value', 0x22: 'Line IRQ Enable', 0x23: 'Line IRQ Line',
        0x2F: 'TM X Scroll MSB', 0x30: 'TM X Scroll LSB', 0x31: 'TM Y Scroll', 0x34: 'Sprite Slot Sel',
        0x35: 'Sprite Attr 0', 0x36: 'Sprite Attr 1', 0x37: 'Sprite Attr 2', 0x38: 'Sprite Attr 3',
        0x39: 'Sprite Attr 4', 0x40: 'Palette Index', 0x41: 'Palette Val 8b', 0x43: 'Palette Control',
        0x44: 'Palette Val 9b', 0x4A: 'Fallback Colour', 0x4B: 'Spr Transp Idx', 0x4C: 'TM Transp Idx',
        0x50: 'MMU Slot 0', 0x51: 'MMU Slot 1', 0x52: 'MMU Slot 2', 0x53: 'MMU Slot 3',
        0x54: 'MMU Slot 4', 0x55: 'MMU Slot 5', 0x56: 'MMU Slot 6', 0x57: 'MMU Slot 7',
        0x60: 'Copper Data', 0x61: 'Copper Addr Lo', 0x62: 'Copper Control', 0x63: 'Copper Data Hi',
        0x68: 'ULA Control', 0x69: 'Display Ctrl 1', 0x6A: 'Display Ctrl 2', 0x6B: 'TM Control',
        0x6C: 'TM Def Attr', 0x6E: 'TM Base Addr', 0x6F: 'TM Pat Base', 0x70: 'L2 Control',
        0x71: 'L2 X Scroll MSB', 0x75: 'Sprite Attr 0*', 0x76: 'Sprite Attr 1*', 0x77: 'Sprite Attr 2*',
        0x78: 'Sprite Attr 3*', 0x79: 'Sprite Attr 4*', 0x7F: 'User Register', 0x80: 'Exp Bus Enable',
        0x81: 'Exp Bus Ctrl', 0x8A: 'Exp Bus I/O', 0x8C: 'Alt ROM Ctrl', 0xB8: 'DivMMC Trap 0',
        0xB9: 'DivMMC Trap 1', 0xBA: 'DivMMC Trap 2', 0xBB: 'DivMMC Trap 3', 0xC0: 'IM2 Control',
        0xC4: 'IM2 Int En 0', 0xC5: 'IM2 Int En 1', 0xC6: 'IM2 Int En 2', 0xC8: 'IM2 Int Stat 0',
        0xC9: 'IM2 Int Stat 1', 0xCA: 'IM2 Int Stat 2',
    };

    // Opravy jmen z JNEXT, která neodpovídají funkci registru: NR $1E/$1F čtou aktuální řádek
    // (emulator.cpp:3232–3239), $0E je sub-verze jádra, $10 ID jádra a tlačítka (port/nextreg.cpp:179–194, :294–297).
    const RENAME = { 0x1E: 'Active Line MSB', 0x1F: 'Active Line LSB', 0x10: 'Core Boot', 0x0E: 'Core Version Sub' };

    // Texty se překládají už při načtení (slovník window.L10N je k dispozici před skripty pohledů).
    const t = NextView.t;

    const G = {
        machine: t('nextreg.group.machine'), video: t('nextreg.group.video'), layer2: t('nextreg.group.layer2'),
        sprites: t('nextreg.group.sprites'), tilemap: t('nextreg.group.tilemap'), copper: t('nextreg.group.copper'),
        palettes: t('nextreg.group.palettes'), mmu: t('nextreg.group.mmu'), sound: t('nextreg.group.sound'), other: t('nextreg.group.other'),
    };
    const GROUPS = [G.machine, G.video, G.layer2, G.sprites, G.tilemap, G.copper, G.palettes, G.mmu, G.sound, G.other];

    // ---- dekodéry hodnot polí
    const YES = t('nextreg.v.yes');
    const NO = t('nextreg.v.no');
    const yes = (v) => (v ? YES : NO);
    const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
    const rgb8 = (v) => 'R' + (v >> 5) + ' G' + ((v >> 2) & 7) + ' B' + (v & 3);
    const SPEED = [t('nextreg.v.speed35'), '7 MHz', '14 MHz', '28 MHz'];
    const TIMING = ['48K', '48K', '128K', '+3', 'Pentagon', '?', '?', '?'];
    const MTYPE = [t('nextreg.v.configMode'), '48K', '128K', '+3', 'Pentagon', '?', '?', '?'];
    const IO_MODE = t('nextreg.v.ioMode');
    const JOY = ['Sinclair 2', 'Kempston 1', 'Cursor', 'Sinclair 1', 'Kempston 2', 'MD 1', 'MD 2', IO_MODE];
    const PAL = ['ULA 1', 'Layer 2 1', t('nextreg.v.sprites', 1), t('nextreg.v.tilemap', 1),
        'ULA 2', 'Layer 2 2', t('nextreg.v.sprites', 2), t('nextreg.v.tilemap', 2)];
    const PRIO = ['SLU', 'LSU', 'SUL', 'LUS', 'USL', 'ULS', t('nextreg.r15.v.mix'), t('nextreg.r15.v.mix5')];
    const first2 = [t('nextreg.v.first'), t('nextreg.v.second')];

    // Společné popisy polí a poznámky
    const BANK16K = t('nextreg.f.bank16k');
    const CLIP_VALUE = t('nextreg.f.clipValue');
    const PAL_OFFSET = t('nextreg.f.paletteOffset');
    const LINE = t('nextreg.f.line');
    const LINE_BIT8 = t('nextreg.f.lineBit8');
    const INDEX = t('nextreg.f.index');
    const MASK = t('nextreg.f.mask');
    const CH_MASK = t('nextreg.f.channelMask');
    const ENABLED = t('nextreg.f.enabled');
    const LINE_INT = t('nextreg.f.lineInt');
    const SAMPLE = t('nextreg.f.sample');
    const VALUE = t('nextreg.f.value');
    const BYTE = t('nextreg.f.byte');
    const AFTER_RESET = t('nextreg.f.afterReset');
    const RESET_TYPE = t('nextreg.f.resetType');
    const WO_NOT_KEPT = t('nextreg.rw.writeOnlyNotKept');
    const WO_PEEK0 = t('nextreg.rw.writeOnlyPeek0');
    const WRITE1_CLEARS = t('nextreg.rw.writeOneClears');

    // Pole: [nejvyšší bit, nejnižší bit, popis, dekodér?]; dekodér = pole textů / funkce (pole, celá hodnota).
    const F = (hi, lo, label, dec) => ({ hi, lo, label, dec });
    const B = (bit, label, dec) => ({ hi: bit, lo: bit, label, dec });

    const R = {};
    /**
     * access: 'rw' / 'r' (jen čtení) / 'w' (jen zápis; peek vrací poslední zápis nebo 0).
     * rw: text o rozdílu čtení × zápis.
     */
    function reg(n, group, access, desc, fields, rw, name) {
        R[n] = {
            n,
            name: name || RENAME[n] || JNEXT[n] || '?',
            fromJnext: !name && !RENAME[n] && n in JNEXT,
            group,
            access,
            desc,
            fields: fields || [],
            rw: rw || '',
        };
    }

    // ---- Stroj
    reg(0x00, G.machine, 'r', t('nextreg.r00.desc'), [F(7, 0, 'ID', (v) => ({ 8: t('nextreg.r00.v.emulator'), 10: 'ZX Spectrum Next', 0xFA: 'Next (anti-brick)' })[v] || String(v))]);
    reg(0x01, G.machine, 'r', t('nextreg.r01.desc'), [F(7, 4, t('nextreg.r01.f.major')), F(3, 0, t('nextreg.r01.f.minor'))]);
    reg(0x02, G.machine, 'rw', t('nextreg.r02.desc'), [
        B(7, t('nextreg.r02.f.busReset'), yes), B(4, t('nextreg.r02.f.ioTrapNmi'), yes), B(3, t('nextreg.r02.f.mfNmiPending'), yes),
        B(2, t('nextreg.r02.f.divNmiPending'), yes), B(1, t('nextreg.r02.f.lastHardReset'), yes), B(0, t('nextreg.r02.f.lastSoftReset'), yes),
    ], t('nextreg.r02.rw'));
    reg(0x03, G.machine, 'rw', t('nextreg.r03.desc'), [
        B(7, t('nextreg.r03.f.palettePending'), yes), F(6, 4, t('nextreg.r03.f.timing'), TIMING), B(3, t('nextreg.r03.f.timingLock'), yes), F(2, 0, t('nextreg.r03.f.machineType'), MTYPE),
    ], t('nextreg.r03.rw'));
    reg(0x04, G.mmu, 'w', t('nextreg.r04.desc'), [F(6, 0, BANK16K)], WO_NOT_KEPT, 'Config Mapping');
    reg(0x05, G.machine, 'rw', t('nextreg.r05.desc'), [
        F(7, 6, t('nextreg.r05.f.joy1'), (f, v) => JOY[((v >> 1) & 4) | f]), F(5, 4, t('nextreg.r05.f.joy2'), (f, v) => JOY[((v << 1) & 4) | f]),
        B(3, t('nextreg.r05.f.joy1Bit2')), B(2, t('nextreg.r05.f.refresh'), (b) => (b ? '60 Hz' : '50 Hz')), B(1, t('nextreg.r05.f.joy2Bit2')), B(0, 'scandoubler', yes),
    ]);
    reg(0x06, G.machine, 'rw', t('nextreg.r06.desc'), [
        B(7, t('nextreg.r06.f.hotkeyF8'), yes), B(6, t('nextreg.r06.f.beepInternal'), yes), B(5, t('nextreg.r06.f.hotkeyF3'), yes),
        B(4, t('nextreg.r06.f.divNmiDrive'), yes), B(3, t('nextreg.r06.f.mfNmiM1'), yes), B(2, 'PS/2', (b) => (b ? t('nextreg.r06.v.mouse') : t('nextreg.r06.v.keyboard'))),
        F(1, 0, t('nextreg.r06.f.audioChip'), ['YM', 'AY', 'YM (10)', t('nextreg.r06.v.ayReset')]),
    ]);
    reg(0x07, G.machine, 'rw', t('nextreg.r07.desc'), [F(5, 4, t('nextreg.r07.f.actual'), SPEED), F(1, 0, t('nextreg.r07.f.requested'), SPEED)],
        t('nextreg.r07.rw'));
    reg(0x08, G.machine, 'rw', t('nextreg.r08.desc'), [
        B(7, t('nextreg.r08.f.unlocked'), yes), B(6, t('nextreg.r08.f.noContention'), yes), B(5, t('nextreg.r08.f.ayStereo'), (b) => (b ? 'ACB' : 'ABC')),
        B(4, t('nextreg.r08.f.internalSpeaker'), yes), B(3, t('nextreg.r08.f.dac'), yes), B(2, t('nextreg.r08.f.portFf'), yes),
        B(1, 'TurboSound', yes), B(0, t('nextreg.r08.f.issue2'), yes),
    ], t('nextreg.r08.rw'));
    reg(0x09, G.machine, 'rw', t('nextreg.r09.desc'), [
        B(7, t('nextreg.r09.f.ayMono', 2), yes), B(6, t('nextreg.r09.f.ayMono', 1), yes), B(5, t('nextreg.r09.f.ayMono', 0), yes), B(4, t('nextreg.r09.f.spriteIdLock'), yes),
        B(2, t('nextreg.r09.f.hdmiAudioOff'), yes), F(1, 0, t('nextreg.r09.f.scanlines'), [t('nextreg.r09.v.none'), '75 %', '50 %', '25 %']),
    ], t('nextreg.r09.rw'));
    reg(0x0A, G.machine, 'rw', t('nextreg.r0A.desc'), [
        F(7, 6, 'Multiface', ['+3', '128 v87.2', '128 v87.12', '48']), B(5, t('nextreg.r0A.f.swapSd'), yes),
        B(4, t('nextreg.r0A.f.automap'), yes), B(3, t('nextreg.r0A.f.swapButtons'), yes),
        F(1, 0, t('nextreg.r0A.f.dpi'), [t('nextreg.r0A.v.low'), t('nextreg.r0A.v.default'), t('nextreg.r0A.v.medium'), t('nextreg.r0A.v.high')]),
    ]);
    reg(0x0B, G.machine, 'rw', t('nextreg.r0B.desc'), [B(7, IO_MODE, yes), F(5, 4, t('nextreg.r0B.f.mode'), ['bit-bang', t('nextreg.r0B.v.clock'), 'UART', 'UART']), B(0, 'iomode 0')]);
    reg(0x0E, G.machine, 'r', t('nextreg.r0E.desc'), [F(7, 0, t('nextreg.r0E.f.subVersion'))]);
    reg(0x0F, G.machine, 'r', t('nextreg.r0F.desc'), [F(3, 0, t('nextreg.r0F.f.revision'))], '', 'Board Issue');
    reg(0x10, G.machine, 'rw', t('nextreg.r10.desc'), [F(6, 2, t('nextreg.r10.f.coreId')), B(1, t('nextreg.r10.f.driveButton'), yes), B(0, t('nextreg.r10.f.nmiButton'), yes)],
        t('nextreg.r10.rw'));
    reg(0x11, G.video, 'rw', t('nextreg.r11.desc'), [F(2, 0, t('nextreg.r11.f.mode'), (v) => (v === 7 ? 'HDMI' : 'VGA ' + v))],
        t('nextreg.r11.rw'));
    reg(0x20, G.machine, 'rw', t('nextreg.r20.desc'), [B(7, LINE_INT, yes), B(6, 'ULA', yes), B(3, 'CTC 3', yes), B(2, 'CTC 2', yes), B(1, 'CTC 1', yes), B(0, 'CTC 0', yes)],
        t('nextreg.r20.rw'), 'Int Generate');

    // ---- Layer 2
    reg(0x12, G.layer2, 'rw', t('nextreg.r12.desc'), [F(6, 0, BANK16K)]);
    reg(0x13, G.layer2, 'rw', t('nextreg.r13.desc'), [F(6, 0, BANK16K)]);
    reg(0x16, G.layer2, 'rw', t('nextreg.r16.desc'), [F(7, 0, 'X')]);
    reg(0x17, G.layer2, 'rw', t('nextreg.r17.desc'), [F(7, 0, 'Y')]);
    reg(0x18, G.layer2, 'rw', t('nextreg.r18.desc'), [F(7, 0, CLIP_VALUE)], t('nextreg.rw.clipRead', '1:0'));
    reg(0x70, G.layer2, 'rw', t('nextreg.r70.desc'), [F(5, 4, t('nextreg.r70.f.resolution'), ['256×192 8bpp', '320×256 8bpp', '640×256 4bpp', '?']), F(3, 0, PAL_OFFSET)]);
    reg(0x71, G.layer2, 'rw', t('nextreg.r71.desc'), [B(0, t('nextreg.r71.f.xBit8'))]);

    // ---- Video (ULA, LoRes, vrstvy, řádky)
    reg(0x14, G.video, 'rw', t('nextreg.r14.desc'), [F(7, 0, 'RRRGGGBB', rgb8)]);
    reg(0x15, G.video, 'rw', t('nextreg.r15.desc'), [
        B(7, 'LoRes', yes), B(6, t('nextreg.r15.f.sprite0OnTop'), yes), B(5, t('nextreg.r15.f.clipInBorder'), yes),
        F(4, 2, t('nextreg.r15.f.order'), PRIO), B(1, t('nextreg.r15.f.overBorder'), yes), B(0, t('nextreg.r15.f.visible'), yes),
    ]);
    reg(0x1A, G.video, 'rw', t('nextreg.r1A.desc'), [F(7, 0, CLIP_VALUE)], t('nextreg.rw.clipRead', '5:4'));
    reg(0x1C, G.video, 'rw', t('nextreg.r1C.desc'), [
        F(7, 6, t('nextreg.r1C.f.tilemapIndex')), F(5, 4, t('nextreg.r1C.f.ulaIndex')), F(3, 2, t('nextreg.r1C.f.spritesIndex')), F(1, 0, t('nextreg.r1C.f.layer2Index')),
    ], t('nextreg.r1C.rw'));
    reg(0x1E, G.video, 'r', t('nextreg.r1E.desc'), [B(0, LINE_BIT8)]);
    reg(0x1F, G.video, 'r', t('nextreg.r1F.desc'), [F(7, 0, LINE)]);
    reg(0x22, G.video, 'rw', t('nextreg.r22.desc'), [
        B(7, t('nextreg.r22.f.intActive'), yes), B(2, t('nextreg.r22.f.ulaIntOff'), yes), B(1, t('nextreg.r22.f.lineInt'), yes), B(0, LINE_BIT8),
    ], t('nextreg.r22.rw'));
    reg(0x23, G.video, 'rw', t('nextreg.r23.desc'), [F(7, 0, LINE)]);
    reg(0x26, G.video, 'rw', t('nextreg.r26.desc'), [F(7, 0, 'X')], '', 'ULA X Scroll');
    reg(0x27, G.video, 'rw', t('nextreg.r27.desc'), [F(7, 0, 'Y')], '', 'ULA Y Scroll');
    reg(0x32, G.video, 'rw', t('nextreg.r32.desc'), [F(7, 0, 'X')], '', 'LoRes X Scroll');
    reg(0x33, G.video, 'rw', t('nextreg.r33.desc'), [F(7, 0, 'Y')], '', 'LoRes Y Scroll');
    reg(0x68, G.video, 'rw', t('nextreg.r68.desc'), [
        B(7, t('nextreg.r68.f.ulaOff'), yes), F(6, 5, t('nextreg.r68.f.blend'), ['ULA', t('nextreg.r68.v.noBlend'), t('nextreg.r68.v.ulaTilemap'), t('nextreg.r68.v.tilemap')]),
        B(4, t('nextreg.r68.f.noExtKeys'), yes), B(3, 'ULA+', yes), B(2, t('nextreg.r68.f.fineScrollX'), yes), B(0, 'stencil', yes),
    ]);
    reg(0x69, G.video, 'rw', t('nextreg.r69.desc'), [
        B(7, t('nextreg.r69.f.layer2On'), yes), B(6, t('nextreg.r69.f.shadowScreen'), yes),
        F(5, 3, t('nextreg.r69.f.hiresColour')),
        F(2, 0, t('nextreg.r69.f.timexMode'), ['standard', t('nextreg.r69.v.altScreen'), 'hi-colour', '?', '?', '?', 'hi-res', '?']),
    ], t('nextreg.r69.rw'));
    reg(0x6A, G.video, 'rw', t('nextreg.r6A.desc'), [B(5, t('nextreg.r6A.f.radastan'), yes), B(4, t('nextreg.r6A.f.radastanDfile'), yes), F(3, 0, PAL_OFFSET)]);

    // ---- Sprity
    reg(0x19, G.sprites, 'rw', t('nextreg.r19.desc'), [F(7, 0, CLIP_VALUE)], t('nextreg.rw.clipRead', '3:2'));
    reg(0x34, G.sprites, 'rw', t('nextreg.r34.desc'), [F(6, 0, t('nextreg.r34.f.sprite'))], t('nextreg.r34.rw'));
    for (let i = 0; i < 5; i++) {
        reg(0x35 + i, G.sprites, 'w', t('nextreg.r35.desc', i), [F(7, 0, t('nextreg.r35.f.attr', i))]);
        reg(0x75 + i, G.sprites, 'w', t('nextreg.r75.desc', i), [F(7, 0, t('nextreg.r35.f.attr', i))]);
    }
    reg(0x4B, G.sprites, 'rw', t('nextreg.r4B.desc'), [F(7, 0, INDEX)]);

    // ---- Tilemapa
    reg(0x1B, G.tilemap, 'rw', t('nextreg.r1B.desc'), [F(7, 0, CLIP_VALUE)], t('nextreg.rw.clipRead', '7:6'));
    reg(0x2F, G.tilemap, 'rw', t('nextreg.r2F.desc'), [F(1, 0, t('nextreg.r2F.f.xBits'))]);
    reg(0x30, G.tilemap, 'rw', t('nextreg.r30.desc'), [F(7, 0, 'X')]);
    reg(0x31, G.tilemap, 'rw', t('nextreg.r31.desc'), [F(7, 0, 'Y')]);
    reg(0x4C, G.tilemap, 'rw', t('nextreg.r4C.desc'), [F(3, 0, INDEX)]);
    reg(0x6B, G.tilemap, 'rw', t('nextreg.r6B.desc'), [
        B(7, ENABLED, yes), B(6, t('nextreg.r6B.f.columns'), (b) => (b ? '80×32' : '40×32')), B(5, t('nextreg.r6B.f.noAttrs'), yes),
        B(4, t('nextreg.r6B.f.palette'), first2), B(3, t('nextreg.r6B.f.textMode'), yes), B(1, t('nextreg.r6B.f.tiles512'), yes), B(0, t('nextreg.r6B.f.overUla'), yes),
    ]);
    reg(0x6C, G.tilemap, 'rw', t('nextreg.r6C.desc'), [
        F(7, 4, PAL_OFFSET), B(3, t('nextreg.r6C.f.mirrorX'), yes), B(2, t('nextreg.r6C.f.mirrorY'), yes), B(1, t('nextreg.r6C.f.rotate'), yes), B(0, t('nextreg.r6C.f.ulaOverBit8')),
    ]);
    const tmBase = (f, v) => t('nextreg.r6E.v.address', v & 0x80 ? 7 : 5, hex2((v & 0x3F)) + '00');
    reg(0x6E, G.tilemap, 'rw', t('nextreg.r6E.desc'), [B(7, t('nextreg.r6E.f.bank7'), yes), F(5, 0, t('nextreg.r6E.f.addrMsb'), tmBase)]);
    reg(0x6F, G.tilemap, 'rw', t('nextreg.r6F.desc'), [B(7, t('nextreg.r6E.f.bank7'), yes), F(5, 0, t('nextreg.r6E.f.addrMsb'), tmBase)]);

    // ---- Palety
    reg(0x40, G.palettes, 'rw', t('nextreg.r40.desc'), [F(7, 0, INDEX)]);
    reg(0x41, G.palettes, 'rw', t('nextreg.r41.desc'), [F(7, 0, 'RRRGGGBB', rgb8)], t('nextreg.r41.rw'));
    reg(0x42, G.palettes, 'rw', t('nextreg.r42.desc'), [F(7, 0, MASK, (v) => (v === 255 ? t('nextreg.r42.v.full') : String(v)))], '', 'ULANext Ink Mask');
    reg(0x43, G.palettes, 'rw', t('nextreg.r43.desc'), [
        B(7, t('nextreg.r43.f.noAutoInc'), yes), F(6, 4, t('nextreg.r43.f.edited'), PAL), B(3, t('nextreg.r43.f.activeSprites'), first2),
        B(2, t('nextreg.r43.f.activeLayer2'), first2), B(1, t('nextreg.r43.f.activeUla'), first2), B(0, 'ULANext', yes),
    ]);
    reg(0x44, G.palettes, 'rw', t('nextreg.r44.desc'), [B(7, t('nextreg.r44.f.priority'), yes), B(0, t('nextreg.r44.f.blueBit0'))],
        t('nextreg.r44.rw'));
    reg(0x4A, G.palettes, 'rw', t('nextreg.r4A.desc'), [F(7, 0, 'RRRGGGBB', rgb8)]);
    reg(0xFF, G.palettes, 'w', t('nextreg.rFF.desc'), [F(7, 0, 'RRRGGGBB', rgb8)], WO_NOT_KEPT, 'ULA+ Pal Poke');

    // ---- MMU
    for (let i = 0; i < 8; i++) {
        const a = (i * 0x2000).toString(16).toUpperCase().padStart(4, '0');
        reg(0x50 + i, G.mmu, 'rw', t('nextreg.r50.desc', a), [F(7, 0, t('nextreg.r50.f.page'), (v) => (v === 0xFF && i < 2 ? 'ROM' : String(v)))]);
    }
    reg(0x8C, G.mmu, 'rw', t('nextreg.r8C.desc'), [
        B(7, t('nextreg.r8C.f.altRom'), yes), B(6, t('nextreg.r8C.f.writeOnly'), yes), B(5, t('nextreg.r8C.f.lockRom1'), yes), B(4, t('nextreg.r8C.f.lockRom0'), yes), F(3, 0, AFTER_RESET),
    ]);
    reg(0x8E, G.mmu, 'rw', t('nextreg.r8E.desc'), [
        B(7, t('nextreg.r8E.f.bankBit3')), F(6, 4, t('nextreg.r8E.f.ramBank')), B(3, t('nextreg.r8E.f.changeBank')),
        B(2, t('nextreg.r8E.f.specialMode'), yes), B(1, t('nextreg.r8E.f.bit1')), B(0, t('nextreg.r8E.f.bit0')),
    ]);
    reg(0x8F, G.mmu, 'rw', t('nextreg.r8F.desc'), [F(1, 0, t('nextreg.r8F.f.mode'), ['128K/+3', '?', 'Pentagon 512K', 'Pentagon 1024K'])], '', 'Mapping Mode');

    // ---- Copper
    reg(0x60, G.copper, 'w', t('nextreg.r60.desc'), [F(7, 0, BYTE)], WO_NOT_KEPT);
    reg(0x61, G.copper, 'rw', t('nextreg.r61.desc'), [F(7, 0, t('nextreg.r61.f.address'))]);
    reg(0x62, G.copper, 'rw', t('nextreg.r62.desc'), [
        F(7, 6, t('nextreg.r62.f.mode'), [t('nextreg.r62.v.stop'), t('nextreg.r62.v.start'), t('nextreg.r62.v.resume'), t('nextreg.r62.v.frameReset')]),
        F(2, 0, t('nextreg.r62.f.addrBits')),
    ]);
    reg(0x63, G.copper, 'w', t('nextreg.r63.desc'), [F(7, 0, BYTE)], t('nextreg.r63.rw'));
    reg(0x64, G.copper, 'rw', t('nextreg.r64.desc'), [F(7, 0, t('nextreg.r64.f.offset'))], t('nextreg.r64.rw'), 'Copper Line Offset');

    // ---- Zvuk
    reg(0x2C, G.sound, 'rw', t('nextreg.r2C.desc'), [F(7, 0, SAMPLE)], t('nextreg.r2C.rw'), 'DAC B Left');
    reg(0x2D, G.sound, 'rw', t('nextreg.r2D.desc'), [F(7, 0, SAMPLE)], t('nextreg.r2D.rw'), 'DAC A+D Mono');
    reg(0x2E, G.sound, 'rw', t('nextreg.r2E.desc'), [F(7, 0, SAMPLE)], t('nextreg.r2E.rw'), 'DAC C Right');
    reg(0xA2, G.sound, 'rw', t('nextreg.rA2.desc'), [], '', 'Pi I2S Audio');

    // ---- Ostatní: klávesnice, sběrnice, Pi, přerušení IM2, pasti
    reg(0x28, G.other, 'rw', t('nextreg.r28.desc'), [F(7, 0, VALUE)], t('nextreg.r28.rw'), 'Keymap Addr MSB');
    reg(0x29, G.other, 'w', t('nextreg.r29.desc'), [], WO_PEEK0, 'Keymap Addr LSB');
    reg(0x2A, G.other, 'w', t('nextreg.r2A.desc'), [], WO_PEEK0, 'Keymap Data MSB');
    reg(0x2B, G.other, 'w', t('nextreg.r2B.desc'), [], WO_PEEK0, 'Keymap Data LSB');
    reg(0x7F, G.machine, 'rw', t('nextreg.r7F.desc'), [F(7, 0, VALUE)]);
    reg(0x80, G.other, 'rw', t('nextreg.r80.desc'), [
        B(7, ENABLED, yes), B(6, t('nextreg.r80.f.romcs'), yes), B(5, t('nextreg.r80.f.noIo'), yes), B(4, t('nextreg.r80.f.noMem'), yes), F(3, 0, AFTER_RESET),
    ]);
    reg(0x81, G.other, 'rw', t('nextreg.r81.desc'), [
        B(7, t('nextreg.r81.f.romcsActive'), yes), B(6, t('nextreg.r81.f.maxClockAlways'), yes), B(5, t('nextreg.r81.f.noNmiDebounce'), yes), B(4, t('nextreg.r81.f.maxClockBus'), yes),
    ], t('nextreg.r81.rw'));
    for (let i = 0; i < 4; i++) {
        reg(0x82 + i, G.other, 'rw', t('nextreg.r82.desc', i), i === 3 ? [B(7, RESET_TYPE, yes), F(3, 0, MASK)] : [F(7, 0, MASK, hex2)], '', 'Int Port Enable ' + i);
        reg(0x86 + i, G.other, 'rw', t('nextreg.r86.desc', i), i === 3 ? [B(7, RESET_TYPE, yes), F(3, 0, MASK)] : [F(7, 0, MASK, hex2)], '', 'Bus Port Enable ' + i);
    }
    reg(0x8A, G.other, 'rw', t('nextreg.r8A.desc'), [F(5, 0, MASK, hex2)]);
    for (let i = 0; i < 4; i++) {
        reg(0x90 + i, G.other, 'rw', t('nextreg.r90.desc', i), [], '', 'Pi GPIO OE ' + i);
        reg(0x98 + i, G.other, 'rw', 'Pi GPIO ' + i, [], '', 'Pi GPIO ' + i);
    }
    reg(0xA0, G.other, 'rw', t('nextreg.rA0.desc'), [
        B(5, t('nextreg.rA0.f.uart'), yes), B(4, t('nextreg.rA0.f.uartVariant')), B(3, t('nextreg.rA0.f.i2c'), yes), B(0, t('nextreg.rA0.f.spi'), yes),
    ], '', 'Pi Peripheral En');
    reg(0xA8, G.other, 'rw', t('nextreg.rA8.desc'), [B(0, 'GPIO 0', yes)], '', 'ESP GPIO OE');
    reg(0xA9, G.other, 'rw', 'ESP GPIO', [], '', 'ESP GPIO');
    const keys = (names) => names.map((k, i) => B(7 - i, k, yes));
    reg(0xB0, G.other, 'r', t('nextreg.rB0.desc'),
        keys([';', '"', ',', '.', t('nextreg.rB0.f.up'), t('nextreg.rB0.f.down'), t('nextreg.rB0.f.left'), t('nextreg.rB0.f.right')]), '', 'Ext Keys 0');
    reg(0xB1, G.other, 'r', t('nextreg.rB1.desc'), keys(['DELETE', 'EDIT', 'BREAK', 'INV VIDEO', 'TRUE VIDEO', 'GRAPH', 'CAPS LOCK', 'EXTEND']), '', 'Ext Keys 1');
    reg(0xB2, G.other, 'r', t('nextreg.rB2.desc'), keys(['P X', 'P Z', 'P Y', 'P MODE', 'L X', 'L Z', 'L Y', 'L MODE']), '', 'MD Pad Buttons');
    reg(0xB8, G.other, 'rw', t('nextreg.rB8.desc'), [F(7, 0, MASK, hex2)]);
    reg(0xB9, G.other, 'rw', t('nextreg.rB9.desc'), [F(7, 0, MASK, hex2)]);
    reg(0xBA, G.other, 'rw', t('nextreg.rBA.desc'), [F(7, 0, MASK, hex2)]);
    reg(0xBB, G.other, 'rw', t('nextreg.rBB.desc'), [F(7, 0, MASK, hex2)]);
    reg(0xC0, G.machine, 'rw', t('nextreg.rC0.desc'), [
        F(7, 5, t('nextreg.rC0.f.vector')), B(3, t('nextreg.rC0.f.stacklessNmi'), yes), F(2, 1, t('nextreg.rC0.f.imMode')), B(0, 'HW IM2', yes),
    ], t('nextreg.rC0.rw'));
    reg(0xC2, G.machine, 'rw', t('nextreg.rC2.desc'), [F(7, 0, 'LSB')], '', 'NMI Return LSB');
    reg(0xC3, G.machine, 'rw', t('nextreg.rC3.desc'), [F(7, 0, 'MSB')], '', 'NMI Return MSB');
    reg(0xC4, G.machine, 'rw', t('nextreg.rC4.desc'), [B(7, t('nextreg.rC4.f.expBus'), yes), B(1, LINE_INT, yes), B(0, 'ULA', yes)]);
    reg(0xC5, G.machine, 'rw', t('nextreg.rC5.desc'), [F(7, 0, CH_MASK, hex2)]);
    const uart = [
        B(6, t('nextreg.f.uartTxEmpty', 1), yes), B(5, t('nextreg.f.uartRxAlmostFull', 1), yes), B(4, t('nextreg.f.uartRxData', 1), yes),
        B(2, t('nextreg.f.uartTxEmpty', 0), yes), B(1, t('nextreg.f.uartRxAlmostFull', 0), yes), B(0, t('nextreg.f.uartRxData', 0), yes),
    ];
    reg(0xC6, G.machine, 'rw', t('nextreg.rC6.desc'), uart);
    reg(0xC8, G.machine, 'rw', t('nextreg.rC8.desc'), [B(1, LINE_INT, yes), B(0, 'ULA', yes)], WRITE1_CLEARS);
    reg(0xC9, G.machine, 'rw', t('nextreg.rC9.desc'), [F(7, 0, CH_MASK, hex2)], WRITE1_CLEARS);
    reg(0xCA, G.machine, 'rw', t('nextreg.rCA.desc'), uart, WRITE1_CLEARS);
    reg(0xCC, G.machine, 'rw', t('nextreg.rCC.desc'), [B(7, 'NMI', yes), B(1, LINE_INT, yes), B(0, 'ULA', yes)], '', 'DMA Int En 0');
    reg(0xCD, G.machine, 'rw', t('nextreg.rCD.desc'), [F(7, 0, CH_MASK, hex2)], '', 'DMA Int En 1');
    reg(0xCE, G.machine, 'rw', t('nextreg.rCE.desc'), uart, '', 'DMA Int En 2');
    reg(0xD8, G.other, 'rw', t('nextreg.rD8.desc'), [B(0, ENABLED, yes)], '', 'IO Trap FDC');
    reg(0xD9, G.other, 'rw', t('nextreg.rD9.desc'), [F(7, 0, BYTE, hex2)], '', 'IO Trap Write');
    reg(0xDA, G.other, 'r', t('nextreg.rDA.desc'), [F(1, 0, t('nextreg.rDA.f.cause'))], '', 'IO Trap Cause');
    reg(0xF0, G.other, 'rw', t('nextreg.rF0.desc'), [], '', 'XDEV Cmd');
    reg(0xF8, G.other, 'rw', t('nextreg.rF8.desc'), [F(6, 0, t('nextreg.rF8.f.register'))], '', 'XADC Reg');
    reg(0xF9, G.other, 'rw', t('nextreg.rF9.desc'), [], '', 'XADC D0');
    reg(0xFA, G.other, 'rw', t('nextreg.rFA.desc'), [], '', 'XADC D1');

    // Registry z panelu JNEXT, které výše nemají vlastní popis.
    for (const k of Object.keys(JNEXT)) {
        const n = Number(k);
        if (!R[n]) reg(n, G.other, 'rw', '', []);
    }
    for (const r of Object.values(R)) {
        r.fields.forEach(Object.freeze);
        Object.freeze(r.fields);
        Object.freeze(r);
    }

    /** Hodnota pole jako text; bez dekodéru číslo pole dekadicky. */
    function fieldText(f, v) {
        const x = (v >> f.lo) & ((1 << (f.hi - f.lo + 1)) - 1);
        if (Array.isArray(f.dec)) return f.dec[x] !== undefined ? f.dec[x] : String(x);
        if (typeof f.dec === 'function') return f.dec(x, v);
        return String(x);
    }

    window.NextRegNames = Object.freeze({
        source: 'JNEXT src/debugger/nextreg_panel.cpp (jména), src/core/emulator.cpp (bity)',
        groups: Object.freeze(GROUPS.slice()),
        /** Seřazená čísla definovaných registrů. */
        list: Object.freeze(Object.keys(R).map(Number).sort((a, b) => a - b)),
        get(n) {
            return R[n] || null;
        },
        name(n) {
            return R[n] ? R[n].name : null;
        },
        /** Rozpis hodnoty na pole: [{bits: '6:4', label, text}]. */
        decode(n, v) {
            const r = R[n];
            if (!r) return [];
            return r.fields.map((f) => ({ bits: f.hi === f.lo ? String(f.hi) : f.hi + ':' + f.lo, label: f.label, text: fieldText(f, v) }));
        },
    });
})();
