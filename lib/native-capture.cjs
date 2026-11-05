'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {check,writeJson}=require('./common.cjs');
const {validateCapture}=require('./native.cjs');
const {profile}=require('./native/fs-abi.cjs');
async function readNativeText(c,handle,base){
 base=BigInt(base);const bytes=Buffer.alloc(profile.captureSize),spans=[];
 for(const range of [...profile.ranges,profile.padding].sort((a,b)=>a.offset-b.offset)){
  const last=spans.at(-1),end=range.offset+range.size;
  if(last&&range.offset<=last.end)last.end=Math.max(last.end,end);else spans.push({offset:range.offset,end});
 }
 let regionEnd=base;
 for(const span of spans){
  let off=span.offset;
  while(off<span.end){
   const address=base+BigInt(off);
   if(address>=regionEnd){
    const info=await c.info(handle,address,8n);
    check(!info.result&&info.programId==='0400000000000000'&&[4,5].includes(info.memory?.permissions)&&info.memory.attributes===0,'Unsupported native FS mapping');
    const start=BigInt(info.memory.address),size=BigInt(info.memory.size);regionEnd=start+size;
    check(size>0n&&start<=address&&regionEnd>address,'Incomplete native FS mapping');
   }
   const n=Math.min(0x200000,span.end-off,Number(regionEnd-address)),r=await c.readBulk(handle,8n,address,n);
   check(!r.result&&Number.isSafeInteger(r.length)&&r.length>0&&r.length<=n,'FS capture RPC failed');
   const meta=r.data;
   check(meta.length>=56&&meta.readBigUInt64LE(0)===8n&&meta.readBigUInt64LE(8)===0x0400000000000000n&&meta.readBigUInt64LE(32)===0n&&meta.readBigUInt64LE(40)===0n,'FS capture identity/alias cleanup differs');
   check(r.bytes.length===r.length&&meta.readBigUInt64LE(48)===BigInt(r.length),'FS capture length differs');
   r.bytes.copy(bytes,off);off+=r.length;
  }
 }
 return bytes;
}
async function captureNative(run,directory,options={}){
 const session=path.basename(run),current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json'))),proof=JSON.parse(await fs.readFile(path.resolve(run,current.file)));
 check(current.verified&&proof.verified&&proof.session===session,'Missing same-session FS 4/4 proof');
 const c=await require('./native/client.cjs').openClient(run);
 const output=path.join(directory,'native-fs/fs-4.bin');await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
 let transferred=false;
 try{
  const handle=await c.fsProcess(),bytes=await readNativeText(c,handle,BigInt(proof.mapping.memory.address)),validation=validateCapture(bytes);
  await fs.writeFile(output,bytes,{mode:0o600});writeJson(path.join(directory,'native-fs/manifest.json'),{session,verified:true,size:bytes.length,...validation});
  if(options.retainClient){transferred=true;return{file:output,client:c,processHandle:handle};}return output;
 }finally{if(!transferred&&!c.pending)await c.close();}
}
module.exports={captureNative,readNativeText};
