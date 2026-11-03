'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {attachGame}=require('./inspect-game.cjs');
// The MKWorld loader supplies the source path explicitly for each mod pack.
const {Bridge}=require('./native-bridge.cjs');
const check=(x,s)=>{if(!x)throw Error(s);};
async function openSource(run,bridge,options={}) {
 const sourcePath=options.path,sourceSize=BigInt(options.size);
 check(typeof sourcePath==='string'&&sourcePath.startsWith('/roms/')&&Number.isSafeInteger(options.size)&&options.size>0,'A verified MKWorld SD source path and size are required');
 const a=await attachGame(run),{s,domain,filesystem}=a;
 let sd,file;
 try {
  sd=domain.oneHandle(await s.ipc('Open own SD source',a.root,18));
  const opened=await filesystem.openFile(s,sd,sourcePath);check(!opened.result,'Mod source unavailable');file=opened.handle;
  check(await filesystem.fileSize(s,file)===sourceSize,'Wrong source file size');
  const layout=JSON.parse(await fs.readFile(path.join(run,'switch2/ro',bridge.session+'-layout.json')));
  async function locate(handle,kind,offset,add,release,read) {
   const clone=domain.oneHandle(await domain.send(s,'Locate pinned '+kind,handle,domain.wire.control(2)));
   let object,vptr,raw;
   try {
    const converted=await domain.send(s,'Convert own '+kind,clone,domain.wire.control(0));
    check(!converted.result,'Cannot locate '+kind);const id=converted.data.readUInt32LE();check(id>0&&id<=layout.count,'Invalid owned domain id');
    const entry=await bridge.m.read(layout.table+(id-1)*0x30,0x30);object=Number(entry.readBigUInt64LE(32));
    raw=await bridge.m.read(object,64);vptr=Number(raw.readBigUInt64LE());
    check(raw.readUInt32LE(offset)>=2&&raw.readUInt32LE(offset)<=16,'Unexpected '+kind+' clone references');
    const table=await bridge.m.read(vptr,80);
    for(const [slot,fn]of [[0,add],[1,release],...(read?[[4,read]]:[])])check(table.readBigUInt64LE(slot*8)===bridge.base+BigInt(fn),'Wrong '+kind+' method table');
   }finally{await s.close(clone);}
   const baseline=await bridge.m.u32(object+offset);
   check(raw.readUInt32LE(offset)===baseline+1&&baseline>=1,'Clone reference did not release exactly once');
   if(kind==='mod-file')check(baseline===1,'Mod file is not exclusively owned');
   return {kind,object,vptr,refOffset:offset,baseline,add,release,read,pinned:false};
  }
  const source={a,sd,file,filesystem:await locate(sd,'SD-filesystem',0x28,0x4b8c0,0x103390),
   fileObject:await locate(file,'mod-file',0x20,0x1036f0,0x104e10,0x104ef0)};
  source.close=()=>a.close();return source;
 }catch(e){await a.close();throw e;}
}
async function pin(bridge,object) {
 check(await bridge.m.u32(object.object+object.refOffset)===object.baseline,'Pin reference baseline changed');
 await bridge.call(object.add,[object.object],'retain-'+object.kind);
 check(await bridge.m.u32(object.object+object.refOffset)===object.baseline+1,'Native AddRef did not increment once');object.pinned=true;
}
async function unpin(bridge,object,clientOpen=true) {
 if(!object.pinned)return;
 check(await bridge.m.u32(object.object+object.refOffset)===(clientOpen?object.baseline+1:1),'Pinned reference count changed');
 await bridge.call(object.release,[object.object],'release-'+object.kind);object.pinned=false;
 if(clientOpen)check(await bridge.m.u32(object.object+object.refOffset)===object.baseline,'Native Release did not decrement once');
}
async function qualify(run) {
 run=path.resolve(run);const b=await new Bridge().open(run);let source,allocation;
 const record={session:b.session,readOnlyFile:true,verified:false};const output=path.join(__dirname,'captures',b.session,'native-source-qualification.json');
 try {
  source=await openSource(run,b);allocation=await b.call(0x694c0,[4096],'source-test-buffer');
  check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native FS buffer allocation failed');
  const at=Number(allocation),before=await b.m.read(at,4096),buffer=Buffer.alloc(4096);
  buffer.writeBigUInt64LE(allocation+1024n,112);buffer.writeBigUInt64LE(128n,120);
  await b.m.write(at,before,buffer);
  record.result=(await b.call(0x104ef0,[source.fileObject.object,allocation+104n,0,allocation+112n,128,0],'native-mod-IFile-Read')).toString();
  const actual=await b.m.read(at,4096),expected=await fs.readFile(path.join(__dirname,'prepared/hsbd01.nx.bea'));
  check(BigInt(record.result)===0n&&actual.readBigUInt64LE(104)===128n&&actual.subarray(1024,1152).equals(expected.subarray(0,128)),'Native source file read differs');
  await pin(b,source.filesystem);await pin(b,source.fileObject);
  await source.close();source.closed=true;
  record.referencesAfterClientClose={filesystem:await b.m.u32(source.filesystem.object+0x28),file:await b.m.u32(source.fileObject.object+0x20)};
  check(record.referencesAfterClientClose.filesystem===source.filesystem.baseline&&record.referencesAfterClientClose.file===1,'Pins did not survive client session cleanup');
  buffer.fill(0,1024,1152);await b.m.write(at,actual,buffer);
  const result=await b.call(0x104ef0,[source.fileObject.object,allocation+104n,0,allocation+112n,128,0],'native-mod-read-after-client-close');
  const after=await b.m.read(at+1024,128);
  check(result===0n&&after.equals(expected.subarray(0,128)),'Native read failed after client session close');
  record.clientClosedReadVerified=true;record.verified=true;
 }catch(e){record.error=e.stack;throw e;}
 finally {
  if(!b.c.pending){
   if(source){await unpin(b,source.fileObject,!source.closed);await unpin(b,source.filesystem,!source.closed);if(!source.closed)await source.close();}
   if(allocation)await b.call(0x69580,[allocation,4096],'free-source-test-buffer');
   await b.close();record.resourcesRetained=false;
  }else record.resourcesRetained=true;
  await fs.writeFile(output,JSON.stringify(record,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({output,...record}));
 }
}
if(require.main===module)qualify(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={openSource,pin,unpin,qualify};
