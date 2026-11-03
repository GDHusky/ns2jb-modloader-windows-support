#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
if(!process.env.NS2_UPSTREAM||!fs.existsSync(path.join(process.env.NS2_UPSTREAM,'run.cjs'))){
 console.error('Set NS2_UPSTREAM to the folder containing Kurumuz ns2jb/run.cjs');
 process.exit(1);
}
process.env.NS2_WORKSPACE=__dirname;
require('./research/superstars-mod/wait-host.cjs');
