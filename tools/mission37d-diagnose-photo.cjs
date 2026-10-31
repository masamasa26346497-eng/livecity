#!/usr/bin/env node
'use strict';
// Read-only diagnostic for Mission37D photo-index / Sumiyoshi tile ID overlap.
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const idxPath=path.join(ROOT,'public/map-data/osaka-city/derived/building-photo-index.json');
const dir=path.join(ROOT,'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
const idx=JSON.parse(fs.readFileSync(idxPath,'utf8'));
const by=idx.byCanonicalId||{};
const keys=Object.keys(by);
const files=fs.readdirSync(dir).filter(f=>/^tile_.*\.json$/.test(f));
const ids=new Set(),samples=[];
let matches=0,parseErrors=0;
for(const f of files){
 const raw=fs.readFileSync(path.join(dir,f),'utf8');
 const rx=/"id"\s*:\s*"(bldg_[0-9a-f-]+)"/g;
 for(const m of raw.matchAll(rx)){ids.add(m[1]);if(samples.length<5)samples.push(m[1]);}
}
const prefix=keys.filter(k=>k.startsWith('cg_'));
const exact=keys.filter(k=>ids.has(k));
const cg=prefix.filter(k=>ids.has(k.slice(3)));
const other=keys.filter(k=>k.startsWith('bldg_'));
console.log(JSON.stringify({tileFiles:files.length,tileIdCount:ids.size,tileIdSamples:samples,indexKeys:keys.length,indexKeySamples:keys.slice(0,5),cgKeys:prefix.length,bldgKeys:other.length,matchedCgToTile:cg.length,matchedDirectToTile:exact.length,matchedCgSamples:cg.slice(0,3),indexTopLevelKeys:Object.keys(idx).slice(0,20)},null,2));
