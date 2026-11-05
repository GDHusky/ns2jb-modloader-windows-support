'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {attachGame}=require('../game-files/mount-api.cjs');
// Retain one SD filesystem; mod bodies stay at their existing paths.
const check=(x,s)=>{if(!x)throw Error(s);};
async function openSource(run,bridge) {
 const a=await attachGame(run),{s,domain}=a;
 let sd;
 try {
  sd=domain.oneHandle(await s.ipc('Open own SD source',a.root,18));
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
  const source={a,sd,filesystem:await locate(sd,'SD-filesystem',0x28,0x4b8c0,0x103390)};
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
module.exports={openSource,pin,unpin};
