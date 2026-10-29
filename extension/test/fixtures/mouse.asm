; Test: Kempstonova myš – program každý snímek čte porty $FBDF (X), $FFDF (Y) a $FADF
; (tlačítka aktivní v 0, kolečko v bitech 7–4) a ukládá je do mx, my, mb.
        DEVICE ZXSPECTRUMNEXT
        ORG $8000
start:  ld sp, $8100
        ei
.loop:  halt
        ld bc, $FBDF
        in a, (c)
        ld (mx), a
        ld b, $FF
        in a, (c)
        ld (my), a
        ld b, $FA
        in a, (c)
        ld (mb), a
        jr .loop
mx:     db 0
my:     db 0
mb:     db 0
        SAVENEX OPEN "mouse.nex", start, $8100
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
