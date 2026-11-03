'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {check,sha}=require('./common.cjs'),{zigCommand}=require('./toolchain.cjs');
let decoder;
function decodeZbic(data,size){
 if(!size&&!data.length)return Buffer.alloc(0);
 if(!decoder){
  const source=path.join(__dirname,'../native/zbic-cli.c'),vendor=path.join(__dirname,'../native/vendor/zstd/zstd.inc');
  const hash=sha(Buffer.concat([fs.readFileSync(source),fs.readFileSync(vendor)]));
  const dir=path.join(__dirname,'../state/tools');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'zbic-'+process.platform+'-'+process.arch+'-'+hash.slice(0,16));
  if(!fs.existsSync(file))cp.execFileSync(zigCommand(),['cc','-O2','-pthread','-ffunction-sections','-fdata-sections','-Wl,--gc-sections',source,'-o',file],{stdio:'pipe'});
  decoder=file;
 }
 const result=cp.spawnSync(decoder,[String(size),String(data.length)],{input:data,maxBuffer:Math.max(size+4096,1024*1024)});
 if(result.error)throw result.error;
 check(result.status===0&&result.stdout.length===size,'Cannot decode NSO ZBIC segment: '+result.stderr?.toString().trim());return result.stdout;
}
module.exports={decodeZbic};
