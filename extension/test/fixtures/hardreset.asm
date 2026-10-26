; Test: program si po 50 snímcích sám vyvolá tvrdý reset (NR $02 bit 1). Bez SD karty ho server
; nahraje znovu (jako aplikace pro Android); `runs` je po novém nahrání zase 1.
        DEVICE ZXSPECTRUMNEXT
        ORG $8000
start:  ld sp, $8100
        ei
        ld a, (runs)
        inc a
        ld (runs), a
        ld b, 50
.w:     halt
        djnz .w
        nextreg $02, 2          ; tvrdý reset
.loop:  jr .loop
runs:   db 0
        SAVENEX OPEN "hardreset.nex", start, $8100
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
