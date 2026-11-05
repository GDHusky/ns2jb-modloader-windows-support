'use strict';
const fs=require('node:fs'),path=require('node:path');
const {attachGame,createGameFiles}=require('./game-files/mount-api.cjs');
const {check,romPath,writeJson}=require('./common.cjs'),{collectMods}=require('./mods.cjs');
async function collectSdMods(run,directory,source='/ns2jb-modloader'){
 romPath(source);check(!fs.existsSync(directory),'An SD inventory already exists for this session');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const a=await attachGame(run),files=createGameFiles(a),tree=new Map([[source,{type:'directory',children:[]}]]);let sd,closed=false;
 async function close(){if(!closed){closed=true;await a.close();}}
 try{
  const opened=await a.s.ipc('Open SD mod inputs',a.root,18);check(!opened.result,'Cannot open the console SD');sd=a.domain.oneHandle(opened);
  async function list(remote,depth=0){
   check(depth<=128,'SD mod directory nesting exceeds its limit');const children=[];
   for(const row of await files.list({handle:sd},remote,()=>false)){
    check(row.name&&!/[\\/\x00]/.test(row.name)&&!['.','..'].includes(row.name),'Invalid SD directory entry');if(['.DS_Store','Thumbs.db','.gitkeep'].includes(row.name))continue;
    const name=romPath(remote+'/'+row.name);check(Buffer.byteLength(name)<0x301,'SD mod path exceeds the filesystem limit');check(['file','directory'].includes(row.type),'Unsupported SD mod entry');
    check(row.type!=='file'||Number.isSafeInteger(row.size)&&row.size>=0,'Invalid SD file extent');children.push(row.name);tree.set(name,{...row,children:[]});if(row.type==='directory')await list(name,depth+1);
   }
   tree.get(remote).children=children;
  }
  for(const name of ['contents','exefs_patches']){
   const remote=source+'/'+name,type=await a.filesystem.pathMethod(a.s,sd,7,remote);if((type.result&0x3fffff)===0x202)continue;
   check(!type.result&&type.data.readUInt32LE()===0,'Expected an SD directory: '+remote);tree.get(source).children.push(name);tree.set(remote,{type:'directory',children:[]});await list(remote);
  }
  function stat(name){const row=tree.get(name);check(row,'Unknown SD input');return{size:row.size,isSymbolicLink:()=>false,isFile:()=>row.type==='file',isDirectory:()=>row.type==='directory'};}
  const io={remote:true,existsSync:name=>tree.has(name),statSync:stat,lstatSync:stat,readdirSync:(name,options)=>tree.get(name).children.map(child=>options?.withFileTypes?{name:child,...stat(name+'/'+child)}:child)};
  const reader={close,async read(name,offset,length){
   const row=tree.get(name);check(!closed&&row?.type==='file'&&offset>=0&&length>=0&&offset+length<=row.size,'SD source changed or exceeds its extent');
   const opened=await a.filesystem.openFile(a.s,sd,name);check(!opened.result,'Cannot open SD source '+name);
   try{check(await a.filesystem.fileSize(a.s,opened.handle)===BigInt(row.size),'SD source size changed');const pieces=[];for(let at=0;at<length;at+=0x40000){const n=Math.min(0x40000,length-at),b=await a.filesystem.readFile(a.s,opened.handle,offset+at,n);check(b.length===n,'Short SD source read');pieces.push(b);}return Buffer.concat(pieces,length);}
   finally{await a.s.close(opened.handle);}
  }};
  const collection=collectMods(source,io);collection.reader=reader;collection.inputDirectory=directory;
  // Only the patch records need to leave SD. Loose game data is read in FS.
  for(const patch of collection.patches){const bytes=await reader.read(patch.sdPath,0,patch.size),file=path.join(directory,'exefs_patches',patch.path);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});patch.file=file;}
  const manifest=[...tree].map(([name,row])=>({path:name,type:row.type,...(row.type==='file'?{size:row.size}:{})}));writeJson(path.join(directory,'inventory.json'),manifest);
  console.log('Found '+manifest.filter(r=>r.type==='file').length+' mod file(s) on SD:'+source+'/');return collection;
 }catch(error){await close();throw error;}
}
module.exports={collectSdMods};
