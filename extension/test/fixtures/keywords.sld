|SLD.data.version|1
||K|KEYWORDS|WPMEM,LOGPOINT,ASSERTION
keywords.asm|5||0|-1|-1|Z|pages.size:8192,pages.count:224,slots.count:8,slots.adr:0,8192,16384,24576,32768,40960,49152,57344
keywords.asm|9||0|4|32768|F|start
keywords.asm|9||0|4|32768|L|,start,
keywords.asm|10||0|4|32768|T|
keywords.asm|11||0|4|32769|T|
keywords.asm|12||0|4|32772|T|
keywords.asm|13||0|4|32774|T|
keywords.asm|14||0|4|32775|T|
keywords.asm|15||0|4|32778|F|loop
keywords.asm|15||0|4|32778|L|,loop,,+used
keywords.asm|16||0|4|32778|K|; LOGPOINT [LOOP] A=${A} hex=${A:hex} cnt=${b@(counter)} lab=${HL:labels} sig=${A-10:signed} f=${F:flags} {lit}
keywords.asm|16||0|4|32778|T|
keywords.asm|17||0|4|32779|T|
keywords.asm|18||0|4|32782|K|; ASSERTION A != 3
keywords.asm|19||0|4|32782|T|
keywords.asm|20||0|4|32784|T|
keywords.asm|21||0|4|32786|K|; LOGPOINT bad ${nosuchlabel} and ${A:weird}
keywords.asm|21||0|4|32786|T|
keywords.asm|22||0|4|32789|T|
keywords.asm|23||0|4|32792|T|
keywords.asm|24||0|4|32793|F|brk_fd
keywords.asm|24||0|4|32793|L|,brk_fd,
keywords.asm|25||0|4|32793|T|
keywords.asm|26||0|4|32795|T|
keywords.asm|27||0|4|32797|F|brk_dd
keywords.asm|27||0|4|32797|L|,brk_dd,
keywords.asm|29||0|4|32799|T|
keywords.asm|30||0|4|32800|K|; ASSERTION
keywords.asm|30||0|4|32800|T|
keywords.asm|31||0|4|32801|T|
keywords.asm|32||0|4|32802|F|finish
keywords.asm|32||0|4|32802|L|,finish,,+used
keywords.asm|33||0|4|32802|T|
keywords.asm|35||0|4|32804|F|counter
keywords.asm|35||0|4|32804|L|,counter,,+used
keywords.asm|36||0|4|32805|K|; WPMEM , 1, w
keywords.asm|36||0|4|32805|F|wtarget
keywords.asm|36||0|4|32805|L|,wtarget,,+used
keywords.asm|37||0|4|32806|K|; WPMEM rtarget, 1, r, A == 7 && !(B == 1)
keywords.asm|37||0|4|32806|F|rtarget
keywords.asm|37||0|4|32806|L|,rtarget,,+used
keywords.asm|38||0|4|32807|K|; WPMEM rtarget, 1, x
keywords.asm|40||0|4|32839|F|stack_top
keywords.asm|40||0|4|32839|L|,stack_top,,+used
