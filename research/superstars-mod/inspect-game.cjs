'use strict';
// Lightweight game IPC helpers backed by the active ns2jb session.
const path=require('node:path');
const engine=path.resolve(__dirname,'../../lib/game-files');
const {createGameFiles,readRomfs}=require(path.join(engine,'mounts.cjs'));
const {attachGame}=require(path.join(engine,'session.cjs'));
const {discoverUpdates}=require(path.join(engine,'content.cjs'));
module.exports={createGameFiles,readRomfs,attachGame,engine,discoverUpdates};
