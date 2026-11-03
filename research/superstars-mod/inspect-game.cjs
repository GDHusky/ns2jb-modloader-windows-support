'use strict';
// Read-only inventory of the user's installed Superstars. No hooks or writes.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const root = path.resolve(process.env.NS2_WORKSPACE || path.join(__dirname, '../..'));
const engine = (process.env.OUNCECAKE_ENGINE || path.join(root, 'work/iz2s-review/IZ2S-Platform/modules/iz-exchange/server/ouncecake/engine'));
const source = path.join(engine, 'mounts.cjs');
const exported = new Module(source, module);
exported.filename = source;
exported.paths = Module._nodeModulePaths(path.dirname(source));
exported._compile(fs.readFileSync(source, 'utf8') + '\nmodule.exports.createGameFiles = createGameFiles;\n', source);
const {createGameFiles, readRomfs} = exported.exports;
const {attachGame} = require(path.join(engine, 'session.cjs'));
const {discoverUpdates} = require(path.join(engine, 'content.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

async function main(run) {
  run = path.resolve(run);
  const session = path.basename(run);
  const out = path.join(__dirname, 'captures', session);
  await fsp.mkdir(out, {recursive: true});
  const owner = path.join(root, 'outputs/dolphin-full-port/build/native-game-active-' + session + '.json');
  if (fs.existsSync(owner)) throw Error('A native game/diagnostic still owns the session: ' + owner);
  const report = {session, title:'01006fe013472000', storage:4, readOnly:true,
    started:new Date().toISOString(), mounts:[], sourceSha256:hash(fs.readFileSync(source))};
  const recordFile = path.join(out, 'game-inventory.json');
  const save = () => fsp.writeFile(recordFile, JSON.stringify(report,null,2)+'\n', {mode:0o600});
  await save();
  const a = await attachGame(run);
  const files = createGameFiles(a);
  const mounts = [];
  try {
    report.updates = await discoverUpdates({...a, title:report.title});
    console.log('Installed updates:', JSON.stringify(report.updates));
    // Use only the installed title's existing entitlement; no ticket import.
    const selected = [null, ...(report.updates.length ? [report.updates[0]] : [])];
    for (const update of selected) {
      const label = update ? 'update' : 'base';
      const options = {title:report.title,storage:report.storage,update};
      let mount;
      try { mount = await files.open(options); }
      catch(error) {
        if (error.nativeResult?.canonical!==0x7d802 || !error.source) throw error;
        report.installedLicensePrepared = await require(path.join(engine,'program.cjs'))
          .prepareInstalledLicense({...a,title:report.title,source:error.source});
        await save();
        mount = await files.open(options);
      }
      mounts.push(mount);
      console.log('Opened', label, mount.kind, mount.size);
      if (mount.kind !== 'storage') throw Error('Expected RomFS IStorage');
      const ranges = new Map();
      const entries = await readRomfs(async(offset,length) => {
        const b = await files.read(mount,offset,length);
        const filename = label+'-'+offset.toString(16)+'-'+length.toString(16)+'.bin';
        await fsp.writeFile(path.join(out,filename), b, {mode:0o600});
        ranges.set(offset+':'+length,{offset,length,filename,sha256:hash(b)});
        return b;
      }, mount.size);
      const targets = entries.filter(e=>e.type==='file' && e.path==='/Archive/hsbd01.nx.bea');
      if (targets.length!==1) throw Error('Expected exactly one board archive in '+label);
      const prefix = await files.read(mount,targets[0].offset,Math.min(128,targets[0].size));
      report.mounts.push({label,source:mount.source,size:mount.size,entries,
        metadata:[...ranges.values()],target:{...targets[0],prefixHex:prefix.toString('hex')}});
      await save();
      console.log(label, JSON.stringify(report.mounts.at(-1).target));
    }
    report.complete=true;
  } catch(error) {report.error=error.stack;throw error;}
  finally {
    for (const mount of mounts.reverse()) await files.close(mount);
    await a.close();
    report.temporarySessionClosed=true;
    report.finished=new Date().toISOString();
    await save();
  }
  console.log(JSON.stringify({recordFile,complete:report.complete,temporarySessionClosed:report.temporarySessionClosed}));
}
if (require.main===module) main(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main,createGameFiles,readRomfs,attachGame,engine,discoverUpdates};
