'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,romPath}=require('./common.cjs');

function walk(root,base=root,io=fs){
 const p=io.remote?path.posix:path;
 check(!io.lstatSync(root).isSymbolicLink(),'Mod paths must not be symlinks: '+root);
 const rows=[];
 for(const e of io.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  const file=p.join(root,e.name);check(!e.isSymbolicLink(),'Mod paths must not be symlinks: '+file);
  const name=romPath('/'+p.relative(base,file).split(p.sep).join('/'));
  if(e.isDirectory()){rows.push({path:name,type:'directory',file});rows.push(...walk(file,base,io));}
  else{check(e.isFile(),'Unsupported mod entry: '+file);rows.push({path:name,type:'file',file,size:io.statSync(file).size,...(io.remote?{sdPath:file}:{})});}
 }
 return rows;
}

// Read the Atmosphere tree directly: contents/<TITLE_ID> and exefs_patches/.
function collectMods(root,io=fs){
 const p=io.remote?path.posix:path;
 // Remote SD inventory paths are POSIX paths even when the PC host is Windows.
 root=io.remote?romPath(root):path.resolve(root);
 const games=[],patches=[],contents=p.join(root,'contents'),patchRoot=p.join(root,'exefs_patches'),ids=new Set();
 if(io.existsSync(contents))for(const e of io.readdirSync(contents,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  check(e.isDirectory()&&!e.isSymbolicLink(),'Expected a Title ID directory under contents/: '+e.name);
  const id=titleId(e.name),dir=p.join(contents,e.name);check(!ids.has(id),'Duplicate Title ID: '+id);ids.add(id);
  const g={titleId:id,romfs:[],exefs:[],patches:[],stubs:[]};
  const cheats=p.join(dir,'cheats');if(io.existsSync(cheats)&&io.statSync(cheats).isDirectory()&&io.readdirSync(cheats).some(name=>!['.gitkeep','.DS_Store','Thumbs.db'].includes(name)))console.warn('WARNING: Skipping cheats for '+id+'; this release loads RomFS, ExeFS and IPS mods.');
  for(const name of io.readdirSync(dir))check(['romfs','exefs','romfs.bin','exefs.nsp','flags','romfs_metadata.bin','cheats'].includes(name)||/^(?:readme|license|copying|credits|changelog)/i.test(name)||/\.(?:md|txt|json)$/i.test(name),
   'Unsupported component '+name+' in '+dir+'. Runtime cheats/plugins require their own loader; refusing to install only part of this mod.');
  for(const section of ['romfs','exefs']){const folder=p.join(dir,section);if(io.existsSync(folder))g[section]=walk(folder,folder,io);}
  for(const [name,key] of [['romfs.bin','romfsImage'],['exefs.nsp','exefsImage']]){
   const file=p.join(dir,name);if(io.existsSync(file)){const st=io.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink(),'Invalid '+name);g[key]={file,size:st.size,...(io.remote?{sdPath:file}:{})};}
  }
  for(const section of ['romfs','exefs']){
   const names=new Set();for(const row of g[section]){const name=row.path.toLowerCase();check(!names.has(name),'Case-conflicting '+section+' entries: '+row.path);names.add(name);}
  }
  check(!g.exefs.some(r=>r.type==='directory'),'ExeFS files must be at the root of exefs/.');
  g.stubs=g.exefs.filter(r=>/\.stub$/.test(r.path)).map(r=>r.path.slice(1,-5));
  g.exefs=g.exefs.filter(r=>!r.path.endsWith('.stub'));
  games.push(g);
 }
 if(io.existsSync(patchRoot))for(const e of io.readdirSync(patchRoot,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  check(e.isDirectory()&&!e.isSymbolicLink(),'Expected a patchset directory under exefs_patches/: '+e.name);
  for(const r of walk(p.join(patchRoot,e.name),p.join(patchRoot,e.name),io)){
   check(r.type==='file'&&/^\/(?:[0-9a-f]{2}){1,32}\.(?:ips|ips32)$/i.test(r.path),'ExeFS patches must be named for an NSO Build ID: '+r.path);
   patches.push({...r,path:e.name+r.path});
  }
 }
 check(patches.length||games.some(g=>g.romfs.length||g.exefs.length||g.stubs.length||g.romfsImage||g.exefsImage),'No supported mods found. Add files under contents/<TITLE_ID>/romfs/ or exefs/, or add IPS patches under exefs_patches/.');
 return{directory:root,games,patches};
}
module.exports={collectMods,walk};
