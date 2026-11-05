'use strict';
const {check,align,sha}=require('./common.cjs');
const HEADER=368,NAMESPACE=112,CONFIG=168,GAME=24,FILE=80;
function records(collection){
 const games=collection.games.map(game=>({titleId:game.titleId,files:[
  ...game.romfs.map(file=>({...file,name:file.path,kind:file.type==='directory'?0:1})),
  ...game.exefs.map(file=>({...file,name:file.path,kind:2})),
  ...game.stubs.map(name=>({name,kind:3})),
  ...[game.romfsImage&&{...game.romfsImage,name:'romfs.bin',kind:4},game.exefsImage&&{...game.exefsImage,name:'exefs.nsp',kind:5}].filter(Boolean)
 ]}));
 for(const game of games)for(const file of game.files)if(file.kind!==0&&file.kind!==3)check(file.sdPath,'Put mod files on the SD before running node load.cjs.');
 return games;
}
function plan(collection,session){
 const games=records(collection),patches=collection.patches.map(patch=>({...patch,name:patch.path,kind:2}));
 check(patches.every(patch=>patch.sdPath),'IPS files must be on the SD');
 return{schema:5,session,lazy:true,titleIds:games.map(game=>game.titleId),lazyGames:games,lazyPatches:patches,views:[],exefs:[],namespaces:[],sources:[],payload:{filename:'payload.bin',size:0,sha256:sha(Buffer.alloc(0))}};
}
function strings(plan){return [...new Set([...plan.lazyGames.flatMap(game=>game.files),...plan.lazyPatches].flatMap(file=>[file.name,file.sdPath].filter(Boolean)))];}
function layout(plan){
 const lazyOffset=HEADER+NAMESPACE,gamesOffset=lazyOffset+CONFIG,filesOffset=align(gamesOffset+plan.lazyGames.length*GAME,16),patchOffset=filesOffset+plan.lazyGames.reduce((n,game)=>n+game.files.length*FILE,0),stringsOffset=patchOffset+plan.lazyPatches.length*FILE;
 const logOffset=align(stringsOffset+strings(plan).reduce((n,s)=>n+Buffer.byteLength(s)+1,0),16),logBufferOffset=align(logOffset+(plan.diagnostics?.size||0),16);
 return{romfs:HEADER,exefs:NAMESPACE,lazyOffset,gamesOffset,filesOffset,patchOffset,stringsOffset,logOffset,logBufferOffset,bytes:align(logBufferOffset+0x4000,4096)};
}
function buildContext(plan,source,base,address,native,active=0){
 base=BigInt(base);address=BigInt(address);const l=layout(plan),buffer=Buffer.alloc(l.bytes),pointers=new Map();
 const u64=(value,at)=>buffer.writeBigUInt64LE(BigInt(value),at);let at=l.stringsOffset;
 for(const text of strings(plan)){pointers.set(text,address+BigInt(at));buffer.write(text,at);at+=Buffer.byteLength(text)+1;}
 buffer.write('NS2LFS02');buffer.writeUInt32LE(active,8);u64(source.filesystem.object,40);u64(base+BigInt(native.sdk.original.fileRead),48);
 u64(address+BigInt(l.romfs),56);u64(base+0x694c0n,104);u64(base+0x1077b0n,112);u64(base+BigInt(native.originalSize),120);u64(base+BigInt(native.namespace.original.open),128);u64(base+0x69580n,136);
 for(const [i,name]of ['fileRead','fileSize','fileRelease','filesystemRelease','storageRelease','directoryRead','directoryCount','directoryRelease'].entries())u64(base+BigInt(native.sdk.original[name]),304+i*8);
 const c=l.romfs;buffer.writeUInt32LE(active,c);buffer.writeUInt32LE(0x34465343,c+4);
 for(const [name,offset]of [['open',8],['directory',16],['type',24]])u64(base+BigInt(native.namespace.original[name]),c+offset);
 u64(BigInt(source.filesystem.object)+8n,c+32);u64(base+BigInt(native.sdk.original.fileRead),c+40);u64(base+BigInt(native.sdk.original.fileSize),c+48);u64(base+BigInt(native.sdk.original.fileRelease),c+56);
 const a=l.lazyOffset;
 check(source.registry!==undefined,'Missing live FS program registry');
 for(const [value,offset]of [[source.registry,0],[base+0x121400n,8],[base+0x24a7a0n,16],[base+0x11ee960n,24],[base+0x215620n,32],[base+0x215800n,40],...['current','program','data'].map((name,i)=>[base+BigInt(native.lazy.original[name]),48+i*8]),[plan.lazyGames.length,72],[address+BigInt(l.gamesOffset),80],[plan.lazyPatches.length,88],[address+BigInt(l.patchOffset),96]])u64(value,a+offset);
 if(source.logFile&&plan.diagnostics){
  const diagnostic=plan.diagnostics,text=Buffer.from(diagnostic.text);check(text.length===diagnostic.size&&text.length<1024*1024,'Invalid report size');text.copy(buffer,l.logOffset);
  for(const [value,offset]of [[source.logFile.object,160],[source.logFile.write,168],[source.logFile.flush,176],[address+BigInt(l.logOffset),184],[text.length,192],[address+BigInt(l.logOffset+diagnostic.readyOffset),280]])u64(value,offset);
  u64(source.logFile.setSize,a+104);u64(text.length,a+112);u64(1024*1024,a+120);u64(address+BigInt(l.logBufferOffset),a+136);
 }
 function file(record,offset){
  u64(pointers.get(record.name),offset);if(record.sdPath)u64(pointers.get(record.sdPath),offset+8);
  u64(record.sourceOffset||0,offset+56);u64(record.size||0,offset+64);buffer.writeUInt32LE(record.kind,offset+72);
 }
 let fileAt=l.filesOffset;
 plan.lazyGames.forEach((game,i)=>{const g=l.gamesOffset+i*GAME;u64('0x'+game.titleId,g);u64(game.files.length,g+8);u64(address+BigInt(fileAt),g+16);for(const record of game.files){file(record,fileAt);fileAt+=FILE;}});
 plan.lazyPatches.forEach((record,i)=>file(record,l.patchOffset+i*FILE));return buffer;
}
module.exports={plan,layout,buildContext,records};
