'use strict';
// Temporary, instance-guarded native calls. Used only while the owned notifier
// and the original SmileBASIC controller are alive. Never the resident reader.
const fs=require('node:fs/promises'),path=require('node:path');
const check=(x,s)=>{if(!x)throw Error(s);};
const CAVE=0x24d100,NOTIFIER=0x1201b0,WIDTH=256;
class Bridge {
 async open(run,options={}) {
  this.caveOffset=options.caveOffset??CAVE;check([CAVE,0x24d800].includes(this.caveOffset),'Unqualified native cave');
  this.run=path.resolve(run);this.session=path.basename(this.run);
  this.dir=path.join(options.directory||path.join(__dirname,'../../state',this.session),'bridge-'+Date.now());await fs.mkdir(this.dir,{recursive:true});
  this.record={session:this.session,operations:[],resourcesRetained:false};this.journal=path.join(this.dir,'journal.json');await this.save();
  const {Client}=require(path.join(this.run,'switch2/process/client.cjs'));this.c=await new Client().open();this.m=this.c.memory;this.h=await this.c.fsProcess();
  const current=JSON.parse(await fs.readFile(path.join(this.run,'switch2/fs-execution-current.json')));
  const proof=JSON.parse(await fs.readFile(current.file));check(proof.verified&&proof.session===this.session,'Wrong FS proof');
  this.base=BigInt(proof.mapping.memory.address);this.cave=this.base+BigInt(this.caveOffset);this.page=this.base+BigInt(this.caveOffset&~4095);
  this.notifier=JSON.parse(await fs.readFile(path.join(this.run,'switch2/ro',this.session+'-notifier-proof.json')));
  check(this.notifier.identityVerified&&await this.m.pointer(this.notifier.E+8)===this.notifier.B&&await this.m.u32(this.notifier.E+16)===1,'Notifier is not exclusively owned');
  const state=await this.m.request({command:'root-native-info'});check(state.notifiers.length===1&&state.worker.joined,'Native worker is active');this.handle=state.notifiers[0];
  this.capture=await fs.readFile(options.captureFile);
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
  at=BigInt(at);
  if(size>128&&at>=this.base&&at+BigInt(size)<=this.base+BigInt(this.capture?.length||0)){
   const input=Buffer.alloc(32);[8n,at,BigInt(size),0n].forEach((n,i)=>input.writeBigUInt64LE(n,i*8));const r=await this.c.worker({kind:'ro-process',handle:this.c.handle,processHandle:this.h,id:0x524f0016,hex:input.toString('hex')},30000);
   check(!r.transport&&!r.result&&String(r.kernelPid)===String(this.c.pid)&&r.length===size,'Bulk native read failed');const meta=Buffer.from(r.data,'hex');check(meta.readBigUInt64LE()===8n&&meta.readBigUInt64LE(8)===0x0400000000000000n&&!meta.readBigUInt64LE(32)&&!meta.readBigUInt64LE(40),'Bulk native identity or cleanup differs');
   const bytes=await fs.readFile(r.outputFile);check(bytes.length===size&&require('../common.cjs').sha(bytes)===r.sha256,'Bulk native read changed');return bytes;
  }
  const out=[];for(let p=0;p<size;){const n=Math.min(128,size-p,4096-Number((at+BigInt(p))&4095n)),r=await this.c.read(this.h,8n,at+BigInt(p),n);check(!r.result&&!r.unmapResult,'Native read failed');out.push(Buffer.from(r.hex,'hex'));p+=n;}return Buffer.concat(out);
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
  const row={label,offset,args:args.map(String),pending:true};this.record.operations.push(row);await this.save();
  return this.invoke(args,row,this.base+BigInt(offset));
 }
 async invoke(args,row,operation,publish=false){
  const code=require('./artifacts.cjs').bridge(this.cave,this.notifier.E,args,{operation,original_tail:this.base+BigInt(NOTIFIER)+16n},publish);
  await this.stage(code);await this.patch(this.base+BigInt(NOTIFIER),this.original,this.hook);this.hooked=true;
  try {
   const r=await this.c.worker({kind:'notifier-probe',handle:this.handle});
   check(!r.transport&&r.canonicalResult===0x6dfe&&!r.copies.length&&!r.moves.length,'Native bridge did not return the nonce');
   row.result=(await this.m.u64(this.notifier.E+8)).toString();row.pending=false;await this.save();return BigInt(row.result);
  } finally {
   if(!this.c.pending){const r=await this.m.u64(this.notifier.E+8);if(r!==BigInt(this.notifier.B))await this.m.writeU64(this.notifier.E+8,r,this.notifier.B);await this.detach();}
  }
 }
 async mapRuntime(code,save){
  check(Buffer.isBuffer(code)&&code.length>0&&code.length%4096===0,'Runtime pages are incomplete');
  const allocated=await this.call(0x694c0,[code.length+4096],'allocate-resident-code'),source=(allocated+4095n)&~4095n,info=await this.c.info(this.h,source,8n),address=BigInt(info.freeAddress||0);
  check(allocated>=0x100000000n&&allocated<0x8000000000n&&!info.result&&info.memory.type===5&&info.memory.permissions===3&&!info.memory.attributes&&source+BigInt(code.length)<=BigInt(info.memory.address)+BigInt(info.memory.size),'Resident code allocation is not Normal/RW memory');
  const target=await this.c.info(this.h,address,8n);check(address>0n&&address%4096n===0n&&!target.result&&target.memory.type===0&&address+BigInt(code.length)<=BigInt(target.memory.address)+BigInt(target.memory.size),'No free resident code mapping');
  const record={allocated:String(allocated),allocationBytes:code.length+4096,source:String(source),address:String(address),bytes:code.length,pages:[],published:false};await save(record);
  for(let off=0;off<code.length;off+=4096){const at=Number(source)+off,part=code.subarray(off,off+4096);await this.m.write(at,await this.m.read(at,part.length),part);}
  for(let off=0;off<code.length;off+=4096){const page={source:String(source+BigInt(off)),address:String(address+BigInt(off)),pending:true};record.pages.push(page);await save(record);const r=await this.c.map(this.h,8n,BigInt(page.source),BigInt(page.address));check(!r.result&&!r.mapResult&&!r.permissionResult,'Cannot map resident RX code');page.pending=false;page.mapped=true;await save(record);}
  const row={label:'publish-resident-code',args:[String(address),String(code.length)],pending:true};this.record.operations.push(row);await this.save();await this.invoke([address,BigInt(code.length)],row,0n,true);record.published=true;await save(record);this.runtime=record;return record;
 }
 async callRuntime(offset,args,label){
  check(this.runtime?.published&&Number.isSafeInteger(offset)&&offset>=0&&offset+16<=this.runtime.bytes&&args.length<=6,'Unqualified resident entry');const address=BigInt(this.runtime.address)+BigInt(offset);
  const mapping=await this.c.info(this.h,address,8n);check(!mapping.result&&mapping.memory.permissions===5,'Resident entry is not RX');
  const row={label,address:String(address),args:args.map(String),pending:true};this.record.operations.push(row);await this.save();return this.invoke(args,row,address);
 }
 async close() {
  if(!this.c)return;
  if(this.c.pending){this.record.resourcesRetained=true;await this.save();return;}
  await this.detach();await this.stage(Buffer.alloc(0));
  if(this.readable){const r=await this.c.request(0x524f0015,this.h,[8n,this.page,4096n,BigInt(this.originalPermission)]);check(!r.result,'Cave readability did not restore');this.readable=false;}
  await this.c.close();this.record.closed=true;await this.save();
 }
}
module.exports={Bridge,CAVE,NOTIFIER,WIDTH};
