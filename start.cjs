#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const upstream=process.env.NS2_UPSTREAM;
if(!upstream||!fs.existsSync(path.join(upstream,'run.cjs'))){
 console.error('Set NS2_UPSTREAM to your Kurumuz ns2jb folder (the one with run.cjs).');
 process.exit(1);
}
process.env.NS2_WORKSPACE=__dirname;
// The installer only accepts a fresh, verified 4/4 run created after this start.
// The user never has to copy a session folder path.
fs.writeFileSync(path.join(__dirname,'.ns2jb-start.json'),
 JSON.stringify({started:new Date().toISOString(),upstream:path.resolve(upstream)},null,2)+'\n',{mode:0o600});
require('./research/superstars-mod/wait-host.cjs');
