; Test: program přes esxDOS přepíše DATA.TXT, vytvoří NEW.TXT a smaže OLD.TXT (relativní cesty:
; v aktuální složce, kam ho při startu do NextZXOS přepne autoexec), pak čeká ve smyčce na `done`.
        DEVICE ZXSPECTRUMNEXT
        ORG $8000
start:  ld sp, $8100
        ld ix, data_txt
        ld hl, text1
        call make
        ld ix, new_txt
        ld hl, text2
        call make
        ld a, '*'
        ld ix, old_txt
        rst $08
        db $ad                  ; F_UNLINK
        ld a, 1
        ld (done), a
        ei
.loop:  halt
        jr .loop

; IX = jméno, HL = text (5 bajtů): vytvořit / přepsat a zapsat
make:   push hl
        ld a, '*'
        ld b, $0e               ; write + creat_trunc
        rst $08
        db $9a                  ; F_OPEN
        pop ix
        ret c
        push af
        ld bc, 5
        rst $08
        db $9e                  ; F_WRITE
        pop af
        rst $08
        db $9b                  ; F_CLOSE
        ret

data_txt: db "DATA.TXT", 0
new_txt:  db "NEW.TXT", 0
old_txt:  db "OLD.TXT", 0
text1:    db "data2"
text2:    db "fresh"
done:     db 0
        SAVENEX OPEN "writer.nex", start, $8100
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
