'use strict';
const fs=require('node:fs'),path=require('node:path');
const {attachGame}=require('./game-files/mount-api.cjs');
const {check,romPath,writeJson}=require('./common.cjs'),{collectMods}=require('./mods.cjs');
async function collectSdMods(run,directory,source='/ns2jb-modloader',options={}){
 romPath(source);check(!fs.existsSync(directory),'An SD inventory already exists for this session');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const {tree,bootstrap}=await require('./native/inventory.cjs').scanSd(run,source,directory);let a,sd,closed=false;
 async function close(){if(!closed){closed=true;if(a)await a.close();}}
 try{
  for(const row of tree.values())if(row.type==='directory')row.children=row.children.filter(name=>!['.DS_Store','Thumbs.db','.gitkeep'].includes(name));
  function stat(name){const row=tree.get(name);check(row,'Unknown SD input');return{size:row.size,isSymbolicLink:()=>false,isFile:()=>row.type==='file',isDirectory:()=>row.type==='directory'};}
  const io={remote:true,existsSync:name=>tree.has(name),statSync:stat,lstatSync:stat,readdirSync:(name,options)=>tree.get(name).children.map(child=>options?.withFileTypes?{name:child,...stat(name+'/'+child)}:child)};
  const collection=collectMods(source,io);collection.inputDirectory=directory;collection.bootstrap=bootstrap;
  const manifest=[...tree].map(([name,row])=>({path:name,type:row.type,...(row.type==='file'?{size:row.size}:{})}));writeJson(path.join(directory,'inventory.json'),manifest);
  console.log('Found '+manifest.filter(r=>r.type==='file').length+' mod file(s) on SD:'+source+'/');
  if(options.nativePreparation)return collection;
  a=await attachGame(run);
  const opened=await a.s.ipc('Open SD mod inputs',a.root,18);check(!opened.result,'Cannot open the console SD');sd=a.domain.oneHandle(opened);
  const reader={close,async read(name,offset,length){
   const row=tree.get(name);check(!closed&&row?.type==='file'&&offset>=0&&length>=0&&offset+length<=row.size,'SD source changed or exceeds its extent');
   const opened=await a.filesystem.openFile(a.s,sd,name);check(!opened.result,'Cannot open SD source '+name);
   try{check(await a.filesystem.fileSize(a.s,opened.handle)===BigInt(row.size),'SD source size changed');const pieces=[];for(let at=0;at<length;at+=0x40000){const n=Math.min(0x40000,length-at),b=await a.filesystem.readFile(a.s,opened.handle,offset+at,n);check(b.length===n,'Short SD source read');pieces.push(b);}return Buffer.concat(pieces,length);}
   finally{await a.s.close(opened.handle);}
  }};
  collection.reader=reader;
  // Only the patch records need to leave SD. Loose game data is read in FS.
  for(const patch of collection.patches){const bytes=await reader.read(patch.sdPath,0,patch.size),file=path.join(directory,'exefs_patches',patch.path);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});patch.file=file;}
  return collection;
 }catch(error){await close();await bootstrap.release();throw error;}
}
module.exports={collectSdMods};
