|SLD.data.version|1
||K|KEYWORDS|WPMEM,LOGPOINT,ASSERTION
features.asm|3||0|-1|-1|Z|pages.size:8192,pages.count:224,slots.count:8,slots.adr:0,8192,16384,24576,32768,40960,49152,57344
features.asm|7||0|4|32768|F|start
features.asm|7||0|4|32768|L|,start,
features.asm|8||0|4|32768|T|
features.asm|9||0|4|32769|T|
features.asm|10||0|4|32772|T|
features.asm|11||0|4|32776|T|
features.asm|12||0|4|32777|T|
features.asm|13||0|4|32780|F|main_loop
features.asm|13||0|4|32780|L|,main_loop,,+used
features.asm|14||0|4|32780|T|
features.asm|15||0|4|32783|T|
features.asm|16||0|4|32784|K|; LOGPOINT [DEMO] A=${A:hex}
features.asm|16||0|4|32784|T|
features.asm|17||0|4|32787|T|
features.asm|18||0|4|32789|T|
features.asm|19||0|4|32791|T|
features.asm|20||0|4|32793|F|main_loop.no_break
features.asm|20||0|4|32793|L|,main_loop,no_break,+local,+used
features.asm|21||0|4|32793|K|; ASSERTION A < 6
features.asm|21||0|4|32793|T|
features.asm|22||0|4|32795|T|
features.asm|23||0|4|32797|F|main_loop.wait
features.asm|23||0|4|32797|L|,main_loop,wait,+local,+used
features.asm|23||0|4|32797|T|
features.asm|24||0|4|32798|T|
features.asm|25||0|4|32800|T|
features.asm|27||0|4|32802|F|counter
features.asm|27||0|4|32802|L|,counter,,+used
features.asm|29||0|4|32803|F|stack_guard
features.asm|29||0|4|32803|L|,stack_guard,
features.asm|30||0|4|32803|K|; WPMEM stack_guard, 2, w
features.asm|32||0|4|32869|F|stack_top
features.asm|32||0|4|32869|L|,stack_top,,+used
