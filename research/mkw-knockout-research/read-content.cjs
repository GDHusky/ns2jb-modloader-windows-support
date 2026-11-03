'use strict';
// Read only the owner's installed MKWorld RomFS and selected route parameters.
// Does not install a hook, modify a save, stop RPC, or restore/replace RO.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createGameFiles,readRomfs,attachGame,engine,discoverUpdates}=require('../superstars-mod/inspect-game.cjs');
const TITLE='0400c3f00006e000';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error(message);};
function selected(name) {
 return /^\/RSDB\/(?:Course|GameRule|LongCourse|RailDefine|GraphRailDefine|BancLink|BancParam)\./.test(name)||
  /^\/System\/GymlArchive\/(?:general_format|misc_gyml)\./.test(name)||
  /^\/Banc\/(?:PathAdditionalData\/)?LongRally_[^/]+\.(?:bcett\.byml\.zs|byml)$/.test(name)||
  /^\/Banc\/(?:PathAdditionalData\/)?InterStageEx1_CentralToRainbow_A_00\.(?:bcett\.byml\.zs|byml)$/.test(name)||
  /^\/AI\/(?:OfflineTour|AnybodySurvivalSeq|MainMenuLobbySurvival)\.module\.ainb$/.test(name);
}
async function main(run,{metadataOnly=false}={}) {
 check(run,'Usage: node read-content.cjs <upstream run directory>');
 run=path.resolve(run);
 const session=path.basename(run),out=path.join(__dirname,'captures',session);
 await fs.mkdir(out,{recursive:true,mode:0o700});
 const reportFile=path.join(out,'mkw-inventory.json');
 const r={session,title:TITLE,storage:4,readOnly:true,metadataOnly,started:new Date().toISOString(),mounts:[]};
 const save=()=>fs.writeFile(reportFile,JSON.stringify(r,null,2)+'\n',{mode:0o600});
 await save();
 const a=await attachGame(run),files=createGameFiles(a);
 const openMounts=[];
 let primaryError;
 try {
  r.updates=await discoverUpdates({...a,title:TITLE});await save();
  for(const update of [null,...r.updates.slice(0,1)]) {
   const label=update?'update':'base';
   const options={title:TITLE,storage:4,...(update?{update}:{})};
   let mount;
   try {mount=await files.open(options);}
   catch(error) {
    if(error.nativeResult?.canonical!==0x7d802||!error.source)throw error;
    r.installedLicensePrepared=await require(path.join(engine,'program.cjs')).prepareInstalledLicense({...a,title:TITLE,source:error.source});
    await save();mount=await files.open(options);
   }
   openMounts.push(mount);check(mount.kind==='storage','Expected RomFS IStorage');
   const dir=path.join(out,label);await fs.mkdir(dir,{recursive:true,mode:0o700});
   const record={label,source:mount.source,size:mount.size,metadata:[],files:[]};
   r.mounts.push(record);await save();
   console.log('Reading',label,'RomFS metadata',mount.size);
   record.entries=await readRomfs(async(offset,length)=>{
    const b=await files.read(mount,offset,length);check(b.length===length,'Short metadata read');
    const filename='metadata-'+offset.toString(16)+'-'+length.toString(16)+'.bin';
    await fs.writeFile(path.join(dir,filename),b,{mode:0o600});
    record.metadata.push({offset,length,filename,sha256:sha(b)});return b;
   },mount.size);
   // A fresh unchanged file supplies the installer's strong storage identity.
   const targets=record.entries.filter(e=>e.type==='file'&&(metadataOnly?e.path==='/AI/OfflineTour.module.ainb':selected(e.path)));
   if(metadataOnly)check(targets.length===1&&targets[0].size>=128,'Missing bounded unchanged identity resource');
   const total=targets.reduce((n,e)=>n+e.size,0);
   check(total<=32*1024*1024,'Selected resources exceed the 32 MiB read budget');
   console.log(label,'selected',targets.length,'files,',total,'bytes');await save();
   for(const entry of targets) {
    const localPath=path.join(label,'romfs',entry.path.slice(1));
    const dest=path.join(out,localPath);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});
    const parts=[];
    for(let offset=0;offset<entry.size;offset+=0x40000) {
     const length=Math.min(0x40000,entry.size-offset);
     const b=await files.read(mount,entry.offset+offset,length);
     check(b.length===length,'Short resource read: '+entry.path);parts.push(b);
    }
    const b=Buffer.concat(parts);check(b.length===entry.size,'Resource size mismatch');
    const temporary=dest+'.partial';await fs.writeFile(temporary,b,{mode:0o600});
    check(sha(await fs.readFile(temporary))===sha(b),'Saved resource hash mismatch');
    await fs.rename(temporary,dest);
    record.files.push({...entry,localPath,sha256:sha(b),verified:true});await save();
    console.log(label,entry.path,entry.size);
   }
   record.complete=true;await files.close(mount);openMounts.splice(openMounts.indexOf(mount),1);await save();
  }
  r.complete=true;
 } catch(error) {primaryError=error;r.error=error.stack;}
 finally {
  r.cleanupErrors=[];
  for(const mount of openMounts.reverse())try{await files.close(mount);}catch(error){r.cleanupErrors.push(error.stack);}
  try {await a.close();r.temporarySessionClosed=true;}catch(error){r.cleanupErrors.push(error.stack);}
  r.finished=new Date().toISOString();await save();
 }
 if(primaryError)throw primaryError;
 check(r.cleanupErrors.length===0,'Temporary session cleanup failed; see report');
 console.log(JSON.stringify({reportFile,complete:r.complete,temporarySessionClosed:r.temporarySessionClosed}));
}
if(require.main===module){
 const args=process.argv.slice(2);
 check(args.length>=1&&args.length<=2&&(!args[1]||args[1]==='--metadata-only'),'Usage: node read-content.cjs RUN [--metadata-only]');
 main(args[0],{metadataOnly:args[1]==='--metadata-only'}).catch(error=>{console.error(error.stack);process.exitCode=1;});
}
module.exports={main,selected};
