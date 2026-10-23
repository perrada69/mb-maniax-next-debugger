; MB Maniax Next Debugger – klíčová slova v komentářích a instrukce BREAK (sjasmplus).
; Překlad: sjasmplus --zxnext=cspect --sld=features.sld --fullpath --lst=features.lst features.asm
        DEVICE ZXSPECTRUMNEXT
        SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION

        ORG $8000
start:
        ei
        ld sp, stack_top
        nextreg $07, 3          ; 28 MHz
        xor a
        ld (counter), a
main_loop:
        ld a, (counter)
        inc a
        ld (counter), a         ; LOGPOINT [DEMO] A=${A:hex}
        cp 3
        jr nz, .no_break
        BREAK                   ; při A = 3 zastaví ladění (BREAK z CSpectu)
.no_break:
        out ($fe), a            ; ASSERTION A < 6
        ld b, 10
.wait:  halt                    ; přerušení musí běžet
        djnz .wait
        jr main_loop

counter:    db 0
; Hlídač zásobníku: zápis sem = přetečení zásobníku, ladění se zastaví.
stack_guard:
            ds 2                ; WPMEM stack_guard, 2, w
            ds 64
stack_top:

        SAVENEX OPEN "features.nex", start, stack_top
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
