'use strict';
// Built into relocatable templates by tools/build.cjs, never assembled on use.
function callSource(count,publish=false){
 if(!Number.isInteger(count)||count<0||count>6)throw Error('Invalid native argument count');
 return `.text
.arch armv8.3-a
.global _start
_start:
 ldr x9, owner
 cmp x0, x9
 b.ne passthrough
 pacibsp
 stp x29, x30, [sp, #-32]!
 str x19, [sp, #16]
 mov x19, x0
 ${Array.from({length:count},(_,i)=>'ldr x'+i+', arg'+i).join('\n ')}
 ${publish?`mov x8, x0
 add x9, x0, x1
1:
 dc cvau, x8
 add x8, x8, #64
 cmp x8, x9
 b.lo 1b
 dsb ish
 mov x8, x0
2:
 ic ivau, x8
 add x8, x8, #64
 cmp x8, x9
 b.lo 2b
 dsb ish
 isb
 mov x0, #0`:`ldr x16, operation
 blr x16`}
 str x0, [x19, #8]
 mov w0, #0x6dfe
 ldr x19, [sp, #16]
 ldp x29, x30, [sp], #32
 retab
passthrough:
 pacibsp
 sub sp, sp, #32
 stp x29, x30, [sp, #16]
 add x29, sp, #16
 b original_tail
.balign 8
owner: .xword 0
operation: .xword 0
${Array.from({length:count},(_,i)=>'arg'+i+': .xword 0').join('\n')}
`;
}
module.exports={callSource};
