#!/usr/bin/env node
'use strict';
// Mario Kart World RomFS beta: install ALL mod folders in one qualified FS
// session. A shared RomFS path is a hard conflict, not a silent override.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=__dirname,mkw=path.join(root,'research/mkw-knockout-research');
const modsRoot=path.join(root,'MarioKartWorld','mods');
const planDir=path.join(mkw,'prepared','probe-pack'),planFile=path.join(planDir,'overlay.json');
const check=(ok,message)=>{if(!ok)throw Error(message)};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const isDirectory=file=>fs.existsSync(file)&&fs.statSync(file).isDirectory();
function cmd(executable,args){
 console.log('\n> '+[executable,...args].join(' '));
 const p=cp.spawnSync(executable,args,{cwd:root,stdio:'inherit',env:process.env});
 if(p.error)throw p.error;
 check(p.status===0,executable+' '+args[0]+' failed. See output above.');
}
function filesUnder(dir,base=dir){
 const files=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=path.join(dir,entry.name);
  check(!entry.isSymbolicLink(),'Symlinks are not supported in mods: '+full);
  if(entry.isDirectory())files.push(...filesUnder(full,base));
  else if(entry.isFile()){
   if(entry.name==='.DS_Store'||entry.name==='Thumbs.db')continue;
   files.push('/'+path.relative(base,full).split(path.sep).join('/'));
  }else throw Error('Unsupported mod entry: '+full);
 }
 return files;
}
function findRomfs(mod){
 const gameId='0400c3f00006e000';
 const candidates=[
  path.join(mod,'romfs'),
  path.join(mod,'atmosphere','contents',gameId,'romfs'),
  path.join(mod,'contents',gameId,'romfs'),
  path.join(mod,gameId,'romfs')
 ].filter(isDirectory);
 check(candidates.length===1,'Expected one romfs/ folder inside '+mod+
   ' (or atmosphere/contents/'+gameId+'/romfs).');
 const folder=candidates[0],parent=path.dirname(folder);
 check(!isDirectory(path.join(parent,'exefs')),
  'This mod also includes exefs/ changes. This beta installs RomFS replacements only: '+mod);
 return folder;
}
function collectMods(){
 check(isDirectory(modsRoot),'Missing MarioKartWorld/mods/ folder.');
 const entries=fs.readdirSync(modsRoot,{withFileTypes:true})
  .filter(entry=>!['.gitkeep','.DS_Store','Thumbs.db'].includes(entry.name))
  .sort((a,b)=>a.name.localeCompare(b.name));
 const dirs=entries.filter(e=>e.isDirectory());
 check(dirs.length===entries.length,'Unzip your mods into MarioKartWorld/mods/. Keep each mod in its own folder.');
 const candidates=dirs.map(e=>({name:e.name,base:path.join(modsRoot,e.name)}));
 const modFolders=[];
 if(isDirectory(path.join(modsRoot,'romfs'))){
  check(candidates.length===1,'Use either mods/romfs/ or separate mods/ModName/romfs/ folders, not both.');
  modFolders.push({name:'Mods',base:modsRoot,romfs:path.join(modsRoot,'romfs')});
 }else for(const mod of candidates){
  modFolders.push({...mod,romfs:findRomfs(mod.base)});
 }
 check(modFolders.length>0,'No mods found. Add folders like MarioKartWorld/mods/Characters/romfs/.');
 const conflicts=new Map(),resources=[];
 for(const mod of modFolders){
  const paths=filesUnder(mod.romfs);
  check(paths.length>0,'Empty romfs/ folder in '+mod.name);
  for(const filename of paths){
   const key=filename.toLowerCase();
   check(!conflicts.has(key),'File conflict: '+filename+
     ' is in both '+conflicts.get(key)+' and '+mod.name+'. Combine or remove one of those mods.');
   conflicts.set(key,mod.name);
   resources.push(filename);
  }
  mod.files=paths.length;
 }
 return {modFolders,resources};
}
function currentSession(){
 const configFile=path.join(root,'.ns2jb-start.json');
 check(fs.existsSync(configFile),'Run node start.cjs first, then wait for FS 4/4.');
 const config=json(configFile);
 const upstream=process.env.NS2_UPSTREAM;
 check(upstream&&path.resolve(upstream)===config.upstream,
  'NS2_UPSTREAM differs from the one used to start ns2jb.');
 const started=Date.parse(config.started);
 check(Number.isFinite(started),'Invalid start marker. Run node start.cjs again.');
 const runsFolder=path.join(config.upstream,'runs');
 check(isDirectory(runsFolder),'No ns2jb runs folder. Start ns2jb first.');
 const found=[];
 for(const entry of fs.readdirSync(runsFolder,{withFileTypes:true})){
  if(!entry.isDirectory()||!entry.name.startsWith('switch2-'))continue;
  const run=path.join(runsFolder,entry.name),file=path.join(run,'result.json');
  if(!fs.existsSync(file))continue;
  let result;
  try{result=json(file)}catch{continue}
  if(!result.verified||result.rpc?.state!=='listening'||!Number.isFinite(Date.parse(result.started))||
      Date.parse(result.started)<started)continue;
  const currentFile=path.join(run,'switch2','fs-execution-current.json');
  if(!fs.existsSync(currentFile))continue;
  let current,proof;
  try{
   current=json(currentFile);
   proof=json(current.file);
  }catch{continue}
  if(!current.verified||!proof.verified||proof.session!==entry.name)continue;
  found.push(run);
 }
 check(found.length===1,found.length?
   'More than one fresh verified session was found. Close extra ns2jb sessions and start again.':
   'No active verified FS 4/4 session found. Wait for the first terminal to say 4/4 verified.');
 return found[0];
}
async function main(){
 check(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--check',
  'Usage: node install.cjs');
 const {modFolders,resources}=collectMods();
 console.log('\nMario Kart World mods:');
 for(const mod of modFolders)console.log('  '+mod.name+' ('+mod.files+' file(s))');
 console.log('Total: '+resources.length+' RomFS replacement(s).');
 if(process.argv[2]==='--check'){console.log('Mod folders checked. No changes were made.');return}
 process.env.NS2_WORKSPACE=root;
 check(process.env.ZIG,'Set ZIG to the Zig compiler path.');
 check(fs.existsSync(path.join(root,'research/superstars-mod/.venv/bin/python')),
  'Set up Python dependencies as shown in README.');
 const run=currentSession(),session=path.basename(run);
 const capture=path.join(mkw,'captures',session);
 check(!fs.existsSync(path.join(capture,'resident-install.json')),
  'This session already has a resident installation. Do not install twice; reboot before trying again.');
 console.log('\nUsing current ns2jb FS session automatically: '+session);
 cmd('node',['research/superstars-mod/capture-fs.cjs',run]);
 cmd('node',['research/mkw-knockout-research/read-content.cjs',run,'--metadata-only']);
 const inv=json(path.join(capture,'mkw-inventory.json'));
 check(inv.complete&&inv.temporarySessionClosed&&!(inv.cleanupErrors||[]).length&&inv.title==='0400c3f00006e000',
  'Mario Kart World metadata capture did not qualify.');
 const view=inv.mounts.find(v=>v.label==='update');
 check(view,'Mario Kart World installed update not found.');
 const originals=resources.map(file=>{
  const matches=view.entries.filter(x=>x.type==='file'&&x.path===file);
  check(matches.length===1,'File not found in this Mario Kart World version: '+file);
  check(matches[0].size<=32*1024*1024,'Original file exceeds 32 MiB capture limit: '+file);
  return {file,size:matches[0].size};
 });
 let batch=[],size=0;
 function flush(){
  if(batch.length){cmd('node',['research/mkw-knockout-research/read-more.cjs',run,...batch]);batch=[];size=0;}
 }
 for(const item of originals){
  if(batch.length&&size+item.size>32*1024*1024)flush();
  batch.push(item.file);size+=item.size;
 }
 flush();
 cmd('python3',['research/mkw-knockout-research/prepare-probe.py',capture,
  '--resources',...modFolders.map(x=>path.dirname(x.romfs)),'--out',planDir]);
 const plan=json(planFile);
 check(plan.session===session&&plan.titleId==='0400c3f00006e000'&&plan.resources?.length===resources.length,
  'Prepared mod pack does not match this console session.');
 cmd('node',['research/mkw-knockout-research/upload-pack.cjs',run,planFile]);
 cmd('node',['research/mkw-knockout-research/install-resident.cjs',run,planFile]);
 const journal=json(path.join(capture,'resident-install.json'));
 check(journal.verified&&journal.active&&journal.hookAttached,
  'Native loader did not qualify. Do not continue.');
 const {apply}=require('./research/superstars-mod/restore-stock-ro.cjs');
 console.log('\n> Restoring original RO service');
 const result=await apply(run,{residentDirectory:capture,contextMagic:'MKWFS002'});
 check(result.stockRoProtocolVerified,'Original RO service verification failed.');
 console.log('\nREADY — All '+modFolders.length+' mod(s) installed for this boot.');
 console.log('Stop the first terminal with Ctrl+C and wait for cleanup.');
 console.log('Then close SmileBASIC (do not reboot) and open Mario Kart World.');
}
main().catch(error=>{
 console.error('\nINSTALL STOPPED: '+(error?.message||error));
 console.error('If the FS hook may already be installed, restart the console before retrying.');
 process.exitCode=1;
});
