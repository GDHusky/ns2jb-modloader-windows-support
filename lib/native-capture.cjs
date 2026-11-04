'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {check,sha,writeJson}=require('./common.cjs');
const {validateCapture}=require('./native.cjs');
const {profile}=require('./native/fs-abi.cjs');
async function readNativeText(c,handle,base,readOutput=file=>fs.readFile(file)){
 base=BigInt(base);const parts=[];let off=0,regionEnd=base;
 while(off<profile.captureSize){
  const address=base+BigInt(off);
  if(address>=regionEnd){
   const info=await c.info(handle,address,8n);
   check(!info.result&&info.programId==='0400000000000000'&&[4,5].includes(info.memory?.permissions)&&info.memory.attributes===0,'Unsupported native FS mapping');
   const start=BigInt(info.memory.address),size=BigInt(info.memory.size);regionEnd=start+size;
   check(size>0n&&start<=address&&regionEnd>address,'Incomplete native FS mapping');
  }
  const n=Math.min(0x200000,profile.captureSize-off,Number(regionEnd-address)),input=Buffer.alloc(32);
  [8n,address,BigInt(n),0n].forEach((value,i)=>input.writeBigUInt64LE(value,8*i));
  const r=await c.worker({kind:'ro-process',handle:c.handle,processHandle:handle,id:0x524f0016,hex:input.toString('hex')},30000);
  check(!r.transport&&!r.result&&String(r.kernelPid)===String(c.pid)&&Number.isSafeInteger(r.length)&&r.length>0&&r.length<=n,'FS capture RPC failed');
  const meta=Buffer.from(r.data,'hex');
  check(meta.length>=48&&meta.readBigUInt64LE(0)===8n&&meta.readBigUInt64LE(8)===0x0400000000000000n&&meta.readBigUInt64LE(32)===0n&&meta.readBigUInt64LE(40)===0n,'FS capture identity/alias cleanup differs');
  const bytes=await readOutput(r.outputFile);check(bytes.length===r.length&&sha(bytes)===r.sha256,'FS capture hash differs');
  parts.push(bytes);off+=bytes.length;
 }
 return Buffer.concat(parts);
}
async function captureNative(run,directory){
 const session=path.basename(run),current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json'))),proof=JSON.parse(await fs.readFile(current.file));
 check(current.verified&&proof.verified&&proof.session===session,'Missing same-session FS 4/4 proof');
 const {Client}=require(path.join(run,'switch2/process/client.cjs')),c=await new Client().open();
 const output=path.join(directory,'native-fs/fs-4.bin');await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
 try{
  const handle=await c.fsProcess(),bytes=await readNativeText(c,handle,BigInt(proof.mapping.memory.address)),validation=validateCapture(bytes);
  await fs.writeFile(output,bytes,{mode:0o600});writeJson(path.join(directory,'native-fs/manifest.json'),{session,verified:true,size:bytes.length,...validation});return output;
 }finally{if(!c.pending)await c.close();}
}
module.exports={captureNative,readNativeText};
