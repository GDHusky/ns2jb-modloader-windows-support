'use strict';
// Offline only. The final FS padding page is composed with RomFS; no RPC here.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {layout}=require('./context.cjs');
const check=(ok,why)=>{if(!ok)throw Error(why);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const CAVE=0x24d100,PAGE=0x24d000;
const EXPECTED={read:'6207f8b7e408f8b7690440f99f0009eb',size:'7f2303d5ffc300d1fd7b01a9f44f02a9'};
function branch(from,to){const d=BigInt(to)-BigInt(from);check(d%4n===0n&&d>=-0x8000000n&&d<0x8000000n,'A64 branch out of range');return(0x14000000|Number((d/4n)&0x3ffffffn))>>>0;}
function target(word,at,bits,shift=0){let n=(word>>>shift)&(2**bits-1);if(n>=2**(bits-1))n-=2**bits;return at+4*n;}
function validateCapture(bytes){
 const validation=require('./native/fs-abi.cjs').validateFsAbi(bytes);
 check(bytes.subarray(0x104ef0,0x104f00).toString('hex')===EXPECTED.read,'IFile Read displaced words differ');
 check(bytes.subarray(0x105480,0x105490).toString('hex')===EXPECTED.size,'IFile Size displaced words differ');
 check(target(bytes.readUInt32LE(0x104ef0),0x104ef0,14,5)===0x104fdc&&target(bytes.readUInt32LE(0x104ef4),0x104ef4,14,5)===0x105010,'Original TBNZ targets differ');
 return {...validation,readDisplacedWords:[0xb7f80762,0xb7f808e4,0xf9400469,0xeb09009f],sizeDisplacedWords:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4],readInvalidOffset:0x104fdc,readInvalidSize:0x105010};
}
async function buildAll(base,context,plan,options){
 base=BigInt(base);context=BigInt(context);const l=layout(plan),runtimeAddress=BigInt(options.runtimeAddress??0x8000000n);
 check(runtimeAddress%4096n===0n,'Runtime mapping must be page aligned');
 const template=require('./native/artifacts.cjs').runtime(context,l.exefs?context+BigInt(l.romfs):0n),runtimeCode=Buffer.alloc((template.code.length+4095)&~4095);template.code.copy(runtimeCode);
 const capture=await fs.readFile(options.capture);validateCapture(capture);
 const {ABI}=require('./native-namespace.cjs'),code=Buffer.alloc(192),offsets=template.offsets,entries={};
 for(let i=0;i<code.length;i+=4)code.writeUInt32LE(0xd503201f,i);
 for(const [i,name]of ['read','size','open','directory','type'].entries()){
  const symbol=name==='read'?'lfs_read_entry':name==='size'?'lfs_size_entry':'lfs_namespace_'+name+'_entry';
  check(Number.isSafeInteger(offsets[symbol]),'Missing runtime entry '+symbol);const at=i*16;
  code.writeUInt32LE(0x58000050,at);code.writeUInt32LE(0xd61f0200,at+4);code.writeBigUInt64LE(runtimeAddress+BigInt(offsets[symbol]),at+8);entries[name]=CAVE+at;
 }
 const original={};
 for(const [i,[name,a]]of Object.entries(ABI).entries()){
  check(a.words.every((w,j)=>capture.readUInt32LE(a.offset+j*4)===w),'Namespace gateway prologue differs');
  const at=80+i*32;original[name]=CAVE+at;code.writeUInt32LE(0xd503245f,at);capture.copy(code,at+4,a.offset,a.offset+16);code.writeUInt32LE(branch(base+BigInt(CAVE+at+20),base+BigInt(a.offset+16)),at+20);
 }
 const sizeAt=176;code.writeUInt32LE(0xd503245f,sizeAt);code.writeUInt32LE(0xd503237f,sizeAt+4);code.writeUInt32LE(branch(base+BigInt(CAVE+sizeAt+8),base+0x107604n),sizeAt+8);
 const hooks=[];
 if(l.exefs)for(const [name,a]of Object.entries(ABI)){
  const replacement=Buffer.alloc(16);replacement.writeUInt32LE(0xd503245f);replacement.writeUInt32LE(branch(base+BigInt(a.offset+4),base+BigInt(entries[name])),4);replacement.writeUInt32LE(0xd503201f,8);replacement.writeUInt32LE(0xd503201f,12);
  hooks.push({name:'ExeFS.'+name,offset:a.offset,target:String(base+BigInt(a.offset)),originalHex:capture.subarray(a.offset,a.offset+16).toString('hex'),replacementHex:replacement.toString('hex')});
 }
 if(plan.views.length)for(const [name,offset,destination]of [['RomFS.Read',0x107570,entries.read],['RomFS.GetSize',0x107600,entries.size]]){
  const original=capture.subarray(offset,offset+16);check(original.readUInt32LE(0)===(name==='RomFS.Read'?0x91002000:0xd503237f),'RomFS entry ABI differs');const replacement=Buffer.from(original);replacement.writeUInt32LE(branch(base+BigInt(offset),base+BigInt(destination)));hooks.push({name,offset,target:String(base+BigInt(offset)),originalHex:original.toString('hex'),replacementHex:replacement.toString('hex')});
 }
 const result={hooks,romfsBytes:template.code.length,codefsBytes:0,namespace:{original,entries:{open:entries.open,directory:entries.directory,type:entries.type}},originalSize:CAVE+sizeAt,context:l,base:String(base),address:String(context),entry:String(base+BigInt(entries.read)),offsets,runtimeAddress:String(runtimeAddress),runtimeBytes:runtimeCode.length,runtimeSha256:sha(runtimeCode),codeBytes:code.length,sha256:sha(code)};
 await fs.mkdir(options.directory,{recursive:true});await fs.writeFile(path.join(options.directory,'combined.bin'),code,{mode:0o600});await fs.writeFile(path.join(options.directory,'runtime.bin'),runtimeCode,{mode:0o600});await fs.writeFile(path.join(options.directory,'combined-layout.json'),JSON.stringify(result,null,2)+'\n');return{...result,code,runtimeCode};
}
module.exports={buildAll,branch,validateCapture,CAVE,PAGE};
