'use strict';
// A finite allocator qualification in native FS. All offsets are verified
// against this session's captured text before an instruction is changed.
// No acquisition/bootstrap/upstream file is modified.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const root=path.resolve(process.env.NS2_WORKSPACE || path.join(__dirname,'../..'));
const check=(ok,why)=>{if(!ok)throw Error(why);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const OFF={notifier:0x1201b0,allocate:0x694c0,free:0x69580,cave:0x24d100};
function textSection(elf,loadAddress=0n,externals={}) {
 const sh=Number(elf.readBigUInt64LE(40)),stride=elf.readUInt16LE(58),count=elf.readUInt16LE(60),strIndex=elf.readUInt16LE(62);
 const str=sh+stride*strIndex,so=Number(elf.readBigUInt64LE(str+24)),ss=Number(elf.readBigUInt64LE(str+32));
 const names=elf.subarray(so,so+ss);
 for(let i=0;i<count;i++) {
  const at=sh+i*stride,n=elf.readUInt32LE(at),end=names.indexOf(0,n);
  if(names.toString('utf8',n,end)==='.text') {
   const off=Number(elf.readBigUInt64LE(at+24)),size=Number(elf.readBigUInt64LE(at+32)),text=Buffer.from(elf.subarray(off,off+size));
   for(let j=0;j<count;j++) {
    const r=sh+j*stride;
    if(elf.readUInt32LE(r+4)!==4||elf.readUInt32LE(r+44)!==i)continue;
    const ro=Number(elf.readBigUInt64LE(r+24)),rs=Number(elf.readBigUInt64LE(r+32)),link=elf.readUInt32LE(r+40);
    const symbolTable=sh+link*stride,symbolOffset=Number(elf.readBigUInt64LE(symbolTable+24));
    for(let k=0;k<rs;k+=24) {
     const position=Number(elf.readBigUInt64LE(ro+k)),info=elf.readBigUInt64LE(ro+k+8),type=Number(info&0xffffffffn),index=Number(info>>32n);
     const sym=symbolOffset+index*24,section=elf.readUInt16LE(sym+6),value=elf.readBigUInt64LE(sym+8),addend=elf.readBigInt64LE(ro+k+16);
     check(type===282||type===283,'Unexpected trampoline relocation '+type);
     let symbol=value;
     if(section===0&&index!==0) {
      const strings=sh+elf.readUInt32LE(symbolTable+40)*stride,stringsOffset=Number(elf.readBigUInt64LE(strings+24));
      const begin=stringsOffset+elf.readUInt32LE(sym),end=elf.indexOf(0,begin),name=elf.toString('utf8',begin,end);
      check(Object.hasOwn(externals,name),'Undefined trampoline symbol: '+name);symbol=externals[name];
     }else check(section===0xfff1||index===0||section===i,'Nonlocal trampoline symbol');
     const target=(section===i?loadAddress:0n)+symbol+addend,delta=target-(loadAddress+BigInt(position));
     check(delta%4n===0n&&delta>=-0x8000000n&&delta<0x8000000n,'Branch outside native text reach');
     text.writeUInt32LE((text.readUInt32LE(position)&0xfc000000|Number(delta/4n&0x3ffffffn))>>>0,position);
    }
   }
   return text;
  }
 }
 throw Error('ELF has no text');
}
async function compile(directory,base,notifier,mode,bytes,address=0n) {
 const prefix=mode==='allocate' ? `mov x0, #${bytes}\n bl fs_allocate\n str x0, [x19, #8]`:
   `ldr x0, allocation\n mov x1, #${bytes}\n bl fs_free`;
 const assembly=`.text
.arch armv8.3-a
.global _start
_start:
 ldr x9, owned_notifier
 cmp x0, x9
 b.ne passthrough
 pacibsp
 stp x29, x30, [sp, #-32]!
 str x19, [sp, #16]
 mov x19, x0
 ${prefix}
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
owned_notifier: .xword ${notifier}
allocation: .xword ${address}
`;
 const stem=path.join(directory,mode),src=stem+'.S',elf=stem+'.elf';
 await fs.writeFile(src,assembly,{mode:0o600});
 const zig=(process.env.ZIG || path.join(root,'work/dolphin-port/zig/zig'));
 cp.execFileSync(zig,['cc','-target','aarch64-freestanding-none','-mcpu=cortex_a78c',
  '-c',src,'-o',elf],{stdio:'pipe'});
 const binary=textSection(await fs.readFile(elf),base+BigInt(OFF.cave),{
  fs_allocate:base+BigInt(OFF.allocate),fs_free:base+BigInt(OFF.free),original_tail:base+BigInt(OFF.notifier)+16n});
 check(binary.length<=0x300,'Allocator trampoline is too large');
 const out=Buffer.alloc((binary.length+15)&~15);binary.copy(out);return out;
}
async function main(run,bytes=4096) {
 check([4096,0x1a00000].includes(bytes),'Only the finite 4 KiB / 26 MiB qualification is supported');
 run=path.resolve(run);const session=path.basename(run);
 const directory=path.join(__dirname,'captures',session,'allocator');await fs.mkdir(directory,{recursive:true});
 const journal=path.join(directory,'qualification-'+Date.now()+'.json');
 const record={session,started:new Date().toISOString(),bytes,pending:false,consoleModInstalled:false,operations:[]};
 const save=()=>fs.writeFile(journal,JSON.stringify(record,null,2)+'\n',{mode:0o600});await save();
 const {Client}=require(path.join(run,'switch2/process/client.cjs'));
 const c=await new Client().open(),m=c.memory;
 let h,base,notifier,entryOriginal,caveOriginal,currentCave,pageRead=false,hooked=false;
 async function patch(at,expected,replacement,label) {
  const row={label,address:at.toString(),expected:expected.toString('hex'),replacement:replacement.toString('hex')};
  record.operations.push(row);await save();
  row.reply=await c.patch(h,8n,at,expected,replacement);await save();
  check(!row.reply.result&&row.reply.expectedMatched&&row.reply.readbackMatched&&!row.reply.unmapResult,'Instruction transaction failed: '+label);
 }
 async function readCode(at,length) {
  const r=await c.read(h,8n,at,length);check(!r.result&&!r.unmapResult,'Native read failed');return Buffer.from(r.hex,'hex');
 }
 async function setCave(code) {
  if(!caveOriginal)caveOriginal=await readCode(base+BigInt(OFF.cave),code.length);
  check(caveOriginal.every(x=>x===0),'Native text tail is not zero padding');
  const previous=currentCave||caveOriginal;
  check(previous.length===code.length,'Trampoline length changed');
  for(let off=0;off<code.length;off+=16) {
   if(previous.subarray(off,off+16).equals(code.subarray(off,off+16)))continue;
   await patch(base+BigInt(OFF.cave+off),previous.subarray(off,off+16),code.subarray(off,off+16),'stage-'+off);
  }
  currentCave=code;
 }
 async function bindHook() {
  const code=Buffer.alloc(16);code.writeUInt32LE((0x14000000|((OFF.cave-OFF.notifier)/4))>>>0);
  for(let i=4;i<16;i+=4)code.writeUInt32LE(0xd503201f,i);
  record.hookHex=code.toString('hex');await save();
  await patch(base+BigInt(OFF.notifier),entryOriginal,code,'attach-owned-notifier');hooked=true;
 }
 async function detachHook() {
  if(!hooked)return;
  await patch(base+BigInt(OFF.notifier),Buffer.from(record.hookHex,'hex'),entryOriginal,'detach-owned-notifier');hooked=false;
 }
 async function invoke() {
  record.pending=true;await save();
  const r=await c.worker({kind:'notifier-probe',handle:notifier.handle});
  record.pending=false;await save();
  check(!r.transport&&r.canonicalResult===0x6dfe&&!r.copies.length&&!r.moves.length,'Wrong finite native reply');return r;
 }
 try {
  h=await c.fsProcess();
  notifier=JSON.parse(await fs.readFile(path.join(run,'switch2/ro',session+'-notifier-proof.json')));
  check(notifier.identityVerified&&notifier.session===session&&await m.pointer(notifier.E+8)===notifier.B,'Owned notifier changed');
  const state=await m.request({command:'root-native-info'});notifier.handle=state.notifiers[0];
  check(state.notifiers.length===1&&state.worker.joined&&await m.u32(notifier.E+0x10)===1,'Notifier is not exclusively owned and idle');
  const current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json')));
  check(current.session===session&&current.verified&&current.restored,'Missing current-session FS execution proof');
  const proof=JSON.parse(await fs.readFile(current.file));
  check(proof.session===session&&proof.verified&&proof.mapping?.memory?.address,'FS execution proof belongs to another session');
  base=BigInt(proof.mapping.memory.address);
  const mapping=await c.info(h,base,8n);
  check(!mapping.result&&mapping.programId==='0400000000000000'&&mapping.memory.type===3&&mapping.memory.permissions===4&&mapping.memory.size==='2416640','FS text identity differs');
  const captured=await fs.readFile(path.join(__dirname,'captures',session,'native-fs/fs-4.bin'));
  record.base=base.toString();record.nativeTextSha256=hash(captured);record.notifier={E:notifier.E,B:notifier.B};await save();
  for(const name of ['allocate','free','notifier']) {
   const actual=await readCode(base+BigInt(OFF[name]),16);
   check(actual.equals(captured.subarray(OFF[name],OFF[name]+16)),'Native allocator opcode mismatch: '+name);
   if(name==='notifier')entryOriginal=actual;
  }
  const a=await compile(directory,base,notifier.E,'allocate',bytes),f0=await compile(directory,base,notifier.E,'free',bytes);
  const width=Math.max(a.length,f0.length),padded=Buffer.alloc(width);a.copy(padded);
  await setCave(padded);
  const page=base+BigInt(OFF.cave&~4095);
  const permission=await c.request(0x524f0015,h,[8n,page,4096n,5n]);
  check(!permission.result,'Native cave read permission failed');pageRead=true;
  await bindHook();
  record.allocateMayHaveOccurred=true;await save();record.allocateReply=await invoke();
  const returned=await m.u64(notifier.E+8);
  record.address=Number(returned);await save();
  await m.writeU64(notifier.E+8,returned,notifier.B);record.backendRestored=true;await save();
  await detachHook();
  if(!returned){record.freed=true;await save();throw Error('Native FS allocator returned null');}
  check(returned>=0x100000000n&&returned<0x8000000000n,'Allocator returned a noncanonical address');
  const address=Number(returned);
  const allocation=await c.info(h,BigInt(address),8n);record.allocationMapping=allocation;await save();
  check(!allocation.result&&allocation.memory.permissions===3&&allocation.memory.attributes===0&&
   address>=Number(allocation.memory.address)&&address+bytes<=Number(allocation.memory.address)+Number(allocation.memory.size),'Allocation is not an ordinary FS RW extent');
  // Nothing is written to the allocation. Free uses its exact returned pair.
  const free=await compile(directory,base,notifier.E,'free',bytes,BigInt(address));
  const freePadded=Buffer.alloc(width);free.copy(freePadded);await setCave(freePadded);
  await bindHook();record.freeMayHaveOccurred=true;await save();record.freeReply=await invoke();record.freed=true;await save();
  await detachHook();await setCave(Buffer.alloc(width));
  const restored=await c.request(0x524f0015,h,[8n,page,4096n,4n]);check(!restored.result,'Cave permissions did not restore');pageRead=false;
  record.verified=true;record.paddingRestored=true;
 } catch(e){record.error=e.stack;throw e;}
 finally {
  // No blind replay, free, unhook or unload after an unresolved native call.
  if(!c.pending&&!record.pending) {
   if(record.allocateMayHaveOccurred&&!record.backendRestored) {
    const current=await m.u64(notifier.E+8);
    if(current!==BigInt(notifier.B)) {record.address=Number(current);await save();await m.writeU64(notifier.E+8,current,notifier.B);}
    record.backendRestored=true;
   }
   if(hooked)await detachHook();
   if(currentCave&&(!record.allocateMayHaveOccurred||record.freed))await setCave(Buffer.alloc(currentCave.length));
   if(pageRead&&!hooked&&(!record.allocateMayHaveOccurred||record.freed)) {
    const p=await c.request(0x524f0015,h,[8n,base+BigInt(OFF.cave&~4095),4096n,4n]);record.permissionsRestored=!p.result;
   }
   await c.close();
  }
  record.resourcesRetained=!!((record.allocateMayHaveOccurred&&!record.freed)||c.pending||record.pending||hooked);
  record.finished=new Date().toISOString();await save();console.log(JSON.stringify({journal,verified:!!record.verified,resourcesRetained:record.resourcesRetained}));
 }
}
if(require.main===module)main(process.argv[2],process.argv[3]?Number(process.argv[3]):4096).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={compile,textSection};
