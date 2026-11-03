'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const MOD_SHA='cb5caabafe4d40477d1a0149633158c7896cfecdd894216de3d55a1cf2edbe11';
const TITLE='01006fe013472000';
const DEFAULT_MOD=process.env.SUPERSTARS_MOD_FILE;
async function build(captureDirectory,modFile=DEFAULT_MOD) {
 const directory=path.resolve(captureDirectory),r=JSON.parse(await fs.readFile(path.join(directory,'game-inventory.json')));
 check(r.complete&&r.temporarySessionClosed&&r.title===TITLE,'Incomplete/wrong game inventory');
 check(modFile,'Provide the mod filename as the second argument or SUPERSTARS_MOD_FILE');
 const mod=await fs.readFile(modFile);
 check(sha256(mod)===MOD_SHA&&mod.length===25111566&&mod.toString('ascii',0,4)==='SCNE','Wrong Monopoly archive');
 const output={schema:1,titleId:TITLE,modName:'Monopoly Party',resource:'/Archive/hsbd01.nx.bea',
   payload:{filename:'hsbd01.nx.bea',size:mod.length,sha256:MOD_SHA},views:[],
   consoleInstalled:false,launchSurvivalVerified:false,
   pending:['FS-owned code and payload allocation','Per-title storage binding on game launch',
     'Native Read hook installation and rollback','Validation after SmileBASIC closes']};
 async function captured(m,offset,length) {
  const row=m.metadata.find(x=>x.offset===offset&&x.length===length);
  check(row&&path.basename(row.filename)===row.filename,'Missing exact metadata capture');
  const b=await fs.readFile(path.join(directory,row.filename));
  check(b.length===length&&sha256(b)===row.sha256,'Metadata hash mismatch');return b;
 }
 for(const m of r.mounts) {
  const header=await captured(m,0,0x50),h=Array.from({length:10},(_,i)=>Number(header.readBigUInt64LE(i*8)));
  check(h.every(Number.isSafeInteger)&&h[0]===80,'Invalid header');
  const dirs=await captured(m,h[3],h[4]),files=await captured(m,h[7],h[8]);
  const dirPath=(at,seen=new Set())=>{
   check(at%4===0&&at>=0&&at+24<=dirs.length&&!seen.has(at),'Invalid directory parent');
   seen.add(at);const n=dirs.readUInt32LE(at+20);
   check(n<=0x300&&at+24+n<=dirs.length,'Invalid directory name');
   if(at===0)return '';
   const name=dirs.toString('utf8',at+24,at+24+n);
   check(name.length&&!/[\\/\0]/.test(name),'Invalid path component');
   return dirPath(dirs.readUInt32LE(at),seen)+'/'+name;
  };
  const matches=[];
  for(let at=0;at<files.length;) {
   check(at+32<=files.length,'Truncated file table');const n=files.readUInt32LE(at+28);
   check(n<=0x300&&at+32+n<=files.length,'Invalid filename');
   const name=files.toString('utf8',at+32,at+32+n);
   if(name==='hsbd01.nx.bea'&&dirPath(files.readUInt32LE(at))==='/Archive') matches.push(at);
   at=(at+32+n+3)&~3;
  }
  check(matches.length===1,'Archive entry is not unique');const at=matches[0];
  const offset=h[9]+Number(files.readBigUInt64LE(at+8)),size=Number(files.readBigUInt64LE(at+16));
  check(offset===m.target.offset&&size===m.target.size&&mod.length<=size,'Archive does not fit original extent');
  check(offset>=80&&offset+size<=m.size&&h[7]+at+24<=m.size,'Invalid patch extent');
  const newSize=Buffer.alloc(8);newSize.writeBigUInt64LE(BigInt(mod.length));
  const sizeOffset=h[7]+at+16;
  check(sizeOffset>=offset+size||sizeOffset+8<=offset,'Data/metadata overlap');
  output.views.push({label:m.label,sourceContentId:m.source.contentId,sourceVersion:m.source.version,
   storageSize:m.size,headerHex:header.toString('hex'),headerSha256:sha256(header),
   originalArchivePrefixHex:m.target.prefixHex,originalArchiveSize:size,
   originalFileEntryHex:files.subarray(at,at+32).toString('hex'),fileEntryOffset:h[7]+at,
   segments:[{kind:'payload',offset,length:mod.length,payloadOffset:0},
    {kind:'inline',offset:sizeOffset,length:8,beforeHex:files.subarray(at+16,at+24).toString('hex'),hex:newSize.toString('hex')}]
      .sort((a,b)=>a.offset-b.offset)});
 }
 check(output.views.length===2&&output.views[1].sourceVersion===131072,'Expected captured base plus installed update');
 return {manifest:output,payload:mod};
}
async function main(dir,mod) {
 const result=await build(dir,mod),out=path.join(__dirname,'prepared');await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'hsbd01.nx.bea'),result.payload,{mode:0o600});
 await fs.writeFile(path.join(out,'overlay.json'),JSON.stringify(result.manifest,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({out,views:result.manifest.views.map(v=>({label:v.label,storageSize:v.storageSize,segments:v.segments})),consoleInstalled:false},null,2));
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={build,sha256,TITLE,MOD_SHA};
