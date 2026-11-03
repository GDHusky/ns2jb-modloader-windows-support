'use strict';
// Temporary, instance-guarded native calls. Used only while the owned notifier
// and the original SmileBASIC controller are alive. Never the resident reader.
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const {textSection}=require('./fs-allocator.cjs');
const {zigCommand}=require('../../lib/toolchain.cjs');
const root=path.resolve(process.env.NS2_WORKSPACE || path.join(__dirname,'../..')),check=(x,s)=>{if(!x)throw Error(s);};
const CAVE=0x24d100,NOTIFIER=0x1201b0,WIDTH=256;
async function assemble(dir,source,base,externals={}) {
 await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'native.S'),elf=path.join(dir,'native.o');
 await fs.writeFile(file,source,{mode:0o600});
 cp.execFileSync(zigCommand(),['cc','-target','aarch64-freestanding-none','-mcpu=cortex_a78c','-c',file,'-o',elf]);
 return textSection(await fs.readFile(elf),base,externals);
}
class Bridge {
 async open(run,options={}) {
  this.caveOffset=options.caveOffset??CAVE;check([CAVE,0x24d800].includes(this.caveOffset),'Unqualified native cave');
  this.run=path.resolve(run);this.session=path.basename(this.run);
  this.dir=path.join(__dirname,'captures',this.session,'bridge-'+Date.now());await fs.mkdir(this.dir,{recursive:true});
  this.record={session:this.session,operations:[],resourcesRetained:false};this.journal=path.join(this.dir,'journal.json');await this.save();
  const {Client}=require(path.join(this.run,'switch2/process/client.cjs'));this.c=await new Client().open();this.m=this.c.memory;this.h=await this.c.fsProcess();
  const current=JSON.parse(await fs.readFile(path.join(this.run,'switch2/fs-execution-current.json')));
  const proof=JSON.parse(await fs.readFile(current.file));check(proof.verified&&proof.session===this.session,'Wrong FS proof');
  this.base=BigInt(proof.mapping.memory.address);this.cave=this.base+BigInt(this.caveOffset);this.page=this.base+BigInt(this.caveOffset&~4095);
  this.notifier=JSON.parse(await fs.readFile(path.join(this.run,'switch2/ro',this.session+'-notifier-proof.json')));
  check(this.notifier.identityVerified&&await this.m.pointer(this.notifier.E+8)===this.notifier.B&&await this.m.u32(this.notifier.E+16)===1,'Notifier is not exclusively owned');
  const state=await this.m.request({command:'root-native-info'});check(state.notifiers.length===1&&state.worker.joined,'Native worker is active');this.handle=state.notifiers[0];
  this.capture=await fs.readFile(path.join(__dirname,'captures',this.session,'native-fs/fs-4.bin'));
  this.original=await this.read(this.base+BigInt(NOTIFIER),16);
  check(this.original.equals(this.capture.subarray(NOTIFIER,NOTIFIER+16)),'Notifier instructions changed');
  this.previous=Buffer.alloc(WIDTH);check((await this.read(this.cave,WIDTH)).equals(this.previous),'Temporary cave already occupied');
  const mapping=await this.c.info(this.h,this.page,8n);this.originalPermission=mapping.memory.permissions;
  check(!mapping.result&&[4,5].includes(this.originalPermission),'Wrong native text page permissions');
  const r=await this.c.request(0x524f0015,this.h,[8n,this.page,4096n,5n]);check(!r.result,'Cannot read cave literals');this.readable=true;
  this.hook=Buffer.alloc(16);this.hook.writeUInt32LE((0x14000000|(this.caveOffset-NOTIFIER)/4)>>>0);for(let i=4;i<16;i+=4)this.hook.writeUInt32LE(0xd503201f,i);
  this.record.base=this.base.toString();this.record.notifier=this.notifier;await this.save();return this;
 }
 async save(){await fs.writeFile(this.journal,JSON.stringify(this.record,null,2)+'\n',{mode:0o600});}
 async read(at,size) {
  const out=[];for(let p=0;p<size;p+=128){const r=await this.c.read(this.h,8n,at+BigInt(p),Math.min(128,size-p));check(!r.result&&!r.unmapResult,'Native read failed');out.push(Buffer.from(r.hex,'hex'));}return Buffer.concat(out);
 }
 async patch(at,before,after) {
  const r=await this.c.patch(this.h,8n,at,before,after);
  check(!r.result&&r.expectedMatched&&r.readbackMatched&&!r.unmapResult,'Native instruction patch failed');
 }
 async stage(bytes) {
  check(!this.hooked&&!this.c.pending&&bytes.length<=this.previous.length,'Bridge is busy or code too large');
  const next=Buffer.alloc(this.previous.length);bytes.copy(next);
  for(let i=0;i<next.length;i+=16)if(!next.subarray(i,i+16).equals(this.previous.subarray(i,i+16)))await this.patch(this.cave+BigInt(i),this.previous.subarray(i,i+16),next.subarray(i,i+16));
  this.previous=next;
 }
 async detach() {if(this.hooked){await this.patch(this.base+BigInt(NOTIFIER),this.hook,this.original);this.hooked=false;}}
 async call(offset,args,label) {
  check(Number.isInteger(offset)&&offset>=0&&offset+16<this.capture.length&&args.length<=6,'Invalid native call');
  check((await this.read(this.base+BigInt(offset),16)).equals(this.capture.subarray(offset,offset+16)),'Call target differs');
  const source=`.text\n.arch armv8.3-a\n.global _start\n_start:
 ldr x9, owner
 cmp x0, x9
 b.ne passthrough
 pacibsp
 stp x29, x30, [sp, #-32]!
 str x19, [sp, #16]
 mov x19, x0
 ${args.map((_,i)=>'ldr x'+i+', arg'+i).join('\n ')}
 bl operation
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
owner: .xword ${this.notifier.E}
${args.map((a,i)=>'arg'+i+': .xword '+BigInt(a)).join('\n')}
`;
  const row={label,offset,args:args.map(String),pending:true};this.record.operations.push(row);await this.save();
  const code=await assemble(this.dir,source,this.cave,{operation:this.base+BigInt(offset),original_tail:this.base+BigInt(NOTIFIER)+16n});
  await this.stage(code);await this.patch(this.base+BigInt(NOTIFIER),this.original,this.hook);this.hooked=true;
  try {
   const r=await this.c.worker({kind:'notifier-probe',handle:this.handle});
   check(!r.transport&&r.canonicalResult===0x6dfe&&!r.copies.length&&!r.moves.length,'Native bridge did not return the nonce');
   row.result=(await this.m.u64(this.notifier.E+8)).toString();row.pending=false;await this.save();return BigInt(row.result);
  } finally {
   if(!this.c.pending){const r=await this.m.u64(this.notifier.E+8);if(r!==BigInt(this.notifier.B))await this.m.writeU64(this.notifier.E+8,r,this.notifier.B);await this.detach();}
  }
 }
 async close() {
  if(!this.c)return;
  if(this.c.pending){this.record.resourcesRetained=true;await this.save();return;}
  await this.detach();await this.stage(Buffer.alloc(0));
  if(this.readable){const r=await this.c.request(0x524f0015,this.h,[8n,this.page,4096n,BigInt(this.originalPermission)]);check(!r.result,'Cave readability did not restore');this.readable=false;}
  await this.c.close();this.record.closed=true;await this.save();
 }
}
module.exports={Bridge,assemble,CAVE,NOTIFIER,WIDTH};
