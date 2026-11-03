'use strict';
// Mock transport tests of ordering/failure retention, not a Horizon/SDK test.
const assert=require('node:assert/strict');
const {transition}=require('./restore-stock-ro.cjs');
const PROGRAM=(0x0400000000000037n).toString();
let cases=0;
function transport(options={}) {
 const calls=[];const call=async(name,result)=>{calls.push(name);if(options.fail===name)throw Error('uncertain '+name);return result;};
 return {calls,identify:pid=>call('identify-'+pid,options.wrongIdentity===pid?'0':PROGRAM),
  launch:()=>call('launch',options.newPid||'900'),closeHelper:()=>call('close',{}),
  terminate:pid=>call('terminate-'+pid,{}),start:pid=>call('start-'+pid,{}),
  health:()=>call('health',{moduleInfoVerified:true,applicationInitializeVerified:!options.badHealth})};
}
async function test() {
 let io=transport(),journal={};const saved=[];
 const r=await transition(io,'213',journal,async()=>{saved.push(JSON.parse(JSON.stringify(journal)));});
 assert(r.stockRoProtocolVerified&&!r.gameLaunchVerified);
 assert.deepEqual(io.calls,['identify-213','launch','identify-900','close','terminate-213','start-900','health']);
 assert(saved.some(x=>x.steps.at(-1)?.name==='terminate-identified-helper'&&x.steps.at(-1).pending));cases++;
 for(const failure of ['identify-213','launch','identify-900','close','terminate-213','start-900','health']) {
  io=transport({fail:failure});journal={};await assert.rejects(transition(io,'213',journal,async()=>{}),/uncertain/);
  assert.equal(io.calls.at(-1),failure);assert.equal(journal.steps.at(-1).pending,true);
  assert.equal(journal.stockRoProtocolVerified,undefined);cases++;
 }
 io=transport({newPid:'213'});await assert.rejects(transition(io,'213',{},async()=>{}),/distinct/);
 assert(!io.calls.includes('terminate-213'));cases++;
 io=transport({wrongIdentity:'900'});await assert.rejects(transition(io,'213',{},async()=>{}),/Candidate identity/);
 assert(!io.calls.includes('close')&&!io.calls.includes('terminate-213'));cases++;
 io=transport({badHealth:true});await assert.rejects(transition(io,'213',{},async()=>{}),/ordinary service/);cases++;
 io=transport();await assert.rejects(transition(io,'213',{steps:[{pending:true}]},async()=>{}),/never replayed/);
 assert.equal(io.calls.length,0);cases++;
 io=transport();await assert.rejects(transition(io,'invalid',{},async()=>{}),/Invalid helper PID/);
 assert.equal(io.calls.length,0);cases++;
 console.log(JSON.stringify({passed:cases,scope:'Mock transaction ordering and uncertain-outcome retention; not native SDK validation'}));
}
test().catch(e=>{console.error(e.stack);process.exitCode=1;});
