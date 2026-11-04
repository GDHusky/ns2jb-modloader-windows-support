'use strict';
const {check,sha}=require('../common.cjs');
const profile=require('./fs-abi.json');
function validateFsAbi(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length>=profile.captureSize,'FS capture is incomplete');
 for(const range of profile.ranges)check(sha(bytes.subarray(range.offset,range.offset+range.size))===range.sha256,'Unsupported FS function layout: '+range.purpose);
 const padding=profile.padding;
 check(bytes.subarray(padding.offset,padding.offset+padding.size).every(byte=>byte===0),'FS code padding is already occupied');
 return{profile:1,sha256:sha(bytes),validatedRanges:profile.ranges.length};
}
module.exports={validateFsAbi,profile};
