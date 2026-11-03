'use strict';
const check=(x,s)=>{if(!x)throw Error(s);};
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
// This translates immutable storage coordinates only. Native objects, ASLR
// addresses and handles must always come from the current Bridge/openSource.
async function normalizePlan(plan,capture){
 if(plan.schema===2)return plan;
 check(plan.schema===3&&plan.titleId==='0400c3f00006e000','Wrong MKWorld plan');
 const inventory=JSON.parse(await fs.readFile(path.join(capture,'mkw-inventory.json')));
 check(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors?.length&&inventory.title===plan.titleId&&inventory.session===plan.session,'Incomplete or different source capture');
 const mount=inventory.mounts.find(v=>v.label==='update');
 check(mount?.complete&&mount.source.contentId===plan.sourceContentId&&mount.source.version===plan.sourceVersion&&mount.size===plan.originalStorageSize,'Source ContentID/version/size differs');
 const cache=new Map();
 async function captured(offset,length){
  const out=Buffer.alloc(length);
  for(let at=offset;at<offset+length;){
   const row=mount.metadata.find(r=>r.offset<=at&&at<r.offset+r.length);check(row,'Missing original metadata capture');
   if(!cache.has(row.filename)){
    const blob=await fs.readFile(path.join(capture,'update',row.filename));
    check(blob.length===row.length&&sha(blob)===row.sha256,'Original metadata hash differs');cache.set(row.filename,blob);
   }
   const n=Math.min(offset+length-at,row.offset+row.length-at);cache.get(row.filename).copy(out,at-offset,at-row.offset,at-row.offset+n);at+=n;
  }
  return out;
 }
 const header=await captured(0,80);check(header.toString('hex')===plan.originalHeaderHex&&header.readBigUInt64LE()===80n,'Original header differs');
 const tableOffset=Number(header.readBigUInt64LE(56)),tableSize=Number(header.readBigUInt64LE(64)),dataOffset=Number(header.readBigUInt64LE(72));
 const replaced=new Set(plan.resources.map(r=>r.path));
 const candidate=mount.files.filter(f=>f.verified&&f.size>=128&&!replaced.has(f.path)).sort((a,b)=>a.path.localeCompare(b.path))[0];
 check(candidate,'No captured unchanged file for strong identity');
 const entry=mount.entries.find(e=>e.path===candidate.path&&e.type==='file');
 check(entry&&entry.offset===candidate.offset&&entry.size===candidate.size,'Captured fingerprint extent differs');
 const bytes=await fs.readFile(path.join(capture,candidate.localPath));
 check(bytes.length===candidate.size&&sha(bytes)===candidate.sha256,'Original fingerprint data hash differs');
 const table=await captured(tableOffset,tableSize),name=path.posix.basename(candidate.path);let record;
 for(let at=0;at<table.length;){
  check(at+32<=table.length,'Truncated original file table');const length=table.readUInt32LE(at+28);check(length<=0x300&&at+32+length<=table.length,'Invalid original file record');
  if(table.subarray(at+32,at+32+length).toString()===name&&Number(table.readBigUInt64LE(at+8))+dataOffset===entry.offset&&Number(table.readBigUInt64LE(at+16))===entry.size){check(record===undefined,'Ambiguous fingerprint record');record=at;}
  at=(at+32+length+3)&~3;
 }
 check(record!==undefined,'Fingerprint record not found');
 const view={label:'update',storageSize:mount.size,virtualSize:plan.virtualStorageSize,headerHex:plan.originalHeaderHex,
  fingerprintFileEntryOffset:tableOffset+record,fingerprintDataOffset:entry.offset,
  originalFileEntryHex:table.subarray(record,record+32).toString('hex'),originalPrefixHex:bytes.subarray(0,128).toString('hex'),segments:plan.segments,
  fingerprint:{path:entry.path,localPath:candidate.localPath,size:entry.size,sha256:candidate.sha256,contentId:mount.source.contentId,version:mount.source.version}};
 return {...plan,views:[view],resources:plan.resources.map(r=>({...r,overlayOffset:r.offset,modifiedSize:r.size,modifiedSha256:r.sha256}))};
}
async function loadPlan(filename,capture){
 const plan=JSON.parse(await fs.readFile(filename));
 const normalized=await normalizePlan(plan,capture||path.join(__dirname,'captures',plan.session));
 const payload=await fs.readFile(path.join(path.dirname(filename),plan.payload.filename||'probe-pack.bin'));
 check(payload.length===plan.payload.size&&sha(payload)===plan.payload.sha256,'Local overlay payload differs');
 return normalized;
}
function buildContext(plan,source,base,address,active=0){
 check([2,3].includes(plan.schema)&&plan.titleId==='0400c3f00006e000'&&plan.views?.length>0&&plan.views.length<=2,'Wrong MKWorld plan');
 const buffer=Buffer.alloc(4096);buffer.write('MKWFS002');buffer.writeUInt32LE(active,8);buffer.writeUInt32LE(plan.views.length,12);
 const u64=(n,at)=>buffer.writeBigUInt64LE(BigInt(n),at);
 u64(source.fileObject.object,32);u64(source.filesystem.object,40);u64(base+0x104ef0n,48);u64(base+0x1077b0n,64);u64(plan.payload.size,72);
 let next=128+288*plan.views.length;
 for(let i=0;i<plan.views.length;i++){
  const view=plan.views[i],at=128+288*i;
  check(Number.isSafeInteger(view.storageSize)&&view.storageSize>=80&&Number.isSafeInteger(view.virtualSize)&&view.virtualSize>=view.storageSize,'Invalid virtual storage size');
  check([[view.fingerprintFileEntryOffset,32],[view.fingerprintDataOffset,128]].every(([at,n])=>Number.isSafeInteger(at)&&at>=80&&at+n<=view.storageSize),'Invalid fingerprint extent');
  u64(view.storageSize,at);u64(view.virtualSize,at+8);u64(view.fingerprintFileEntryOffset,at+16);u64(view.fingerprintDataOffset,at+24);
  for(const [hex,where,size]of [[view.headerHex,at+32,80],[view.originalFileEntryHex,at+112,32],[view.originalPrefixHex,at+144,128]]){
   check(typeof hex==='string'&&hex.length===size*2&&/^[0-9a-f]+$/.test(hex),'Invalid identity bytes');Buffer.from(hex,'hex').copy(buffer,where);
  }
  check(view.segments.length>0&&next+view.segments.length*32<=buffer.length,'Too many overlay segments');
  buffer.writeUInt32LE(view.segments.length,at+272);u64(address+BigInt(next),at+280);
  let end=0;
  for(const segment of view.segments){
   check([segment.offset,segment.length,segment.sourceOffset].every(Number.isSafeInteger)&&segment.offset>=end&&segment.length>0&&segment.sourceOffset>=0&&segment.offset+segment.length<=view.virtualSize&&segment.sourceOffset+segment.length<=plan.payload.size,'Invalid overlay segment');
   u64(segment.offset,next);u64(segment.length,next+8);u64(segment.sourceOffset,next+16);end=segment.offset+segment.length;next+=32;
  }
 }
 return buffer;
}
module.exports={buildContext,normalizePlan,loadPlan};
if(require.main===module)loadPlan(path.resolve(process.argv[2]),process.argv[3]).then(plan=>console.log(JSON.stringify(plan))).catch(e=>{console.error(e.stack);process.exitCode=1;});
