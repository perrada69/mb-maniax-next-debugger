; MB Maniax Next Debugger – ukázkový program pro ZX Spectrum Next (sjasmplus).
; Překlad: sjasmplus --sld=hello.sld --fullpath hello.asm
        DEVICE ZXSPECTRUMNEXT
        SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION

        ORG $8000
start:
        ei
        ld sp, stack_top
        nextreg $07, 3          ; 28 MHz
        ld a, 0
        ld (counter), a
main_loop:
        call next_colour
        ld b, 25
.wait:  halt                    ; přerušení musí běžet
        djnz .wait
        jr main_loop

; Okraj o barvu dál (0–7), počítadlo v paměti.
next_colour:
        ld a, (counter)
        inc a
        and 7
        ld (counter), a
        out ($fe), a
        ret

counter:    db 0
            ds 64
stack_top:

        SAVENEX OPEN "hello.nex", start, stack_top
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
