; Testovací program pro integrační testy (test/integration/keywords.test.ts): klíčová slova
; v komentářích a obě podoby instrukce přerušení ladění. Hlavička nesmí obsahovat klíčová slova
; ze SLDOPT (sjasmplus je hledá v každém komentáři).
; Překlad (test/fixtures/build.mjs): sjasmplus --zxnext=cspect --sld=keywords.sld keywords.asm
        DEVICE ZXSPECTRUMNEXT
        SLDOPT COMMENT WPMEM, LOGPOINT, ASSERTION

        ORG $8000
start:
        di
        ld sp, stack_top
        ld b, 0
        xor a
        ld hl, counter
loop:
        inc a                   ; LOGPOINT [LOOP] A=${A} hex=${A:hex} cnt=${b@(counter)} lab=${HL:labels} sig=${A-10:signed} f=${F:flags} {lit}
        ld (counter), a
        ; ASSERTION A != 3
        cp 5
        jr nz, loop
        ld (wtarget), a         ; LOGPOINT bad ${nosuchlabel} and ${A:weird}
        ld a, (rtarget)
        nop
brk_fd:
        BREAK                   ; sjasmplus --zxnext=cspect: FD 00
        ld a, $42
brk_dd:
        db $DD, $01             ; CSpect: DD 01
        ld c, a
        nop                     ; ASSERTION
        nop
finish:
        jr finish

counter:    db 0
wtarget:    db 0                ; WPMEM , 1, w
rtarget:    db 7                ; WPMEM rtarget, 1, r, A == 7 && !(B == 1)
            ; WPMEM rtarget, 1, x
            ds 32
stack_top:

        SAVENEX OPEN "keywords.nex", start, stack_top
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
