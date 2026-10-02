import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingStarts } from '../tools/audit/plateau-source-inventory.js';
import { judgeBuilding } from '../tools/audit/max-lod-reaudit.js';

const surf = (kind, id, lod) => `<bldg:boundedBy><bldg:${kind} gml:id="${id}"><bldg:lod${lod}MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>34.70 135.49 1 34.7001 135.49 1 34.7001 135.4901 1 34.70 135.49 1</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod${lod}MultiSurface></bldg:${kind}></bldg:boundedBy>`;
const building = (id, lod) => `<bldg:Building gml:id="${id}"><gen:stringAttribute name="区名"><gen:value>北区</gen:value></gen:stringAttribute><bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>${surf('RoofSurface','r'+id,lod)}${surf('WallSurface','w'+id,lod)}${surf('GroundSurface','g'+id,lod)}</bldg:Building>`;

test('[35P] BuildingPartではなくBuilding単位で分割する', () => {
  const src = building('a', 2) + '<bldg:BuildingPart gml:id="part"/>' + building('b', 3);
  assert.equal(buildingStarts(src).length, 2);
});

test('[35P] 完全なLOD2をLOD2として判定する', () => {
  const j = judgeBuilding(building('lod2', 2));
  assert.equal(j.lod2.present, true);
  assert.equal(j.lod2.complete, true);
  assert.equal(j.chosen, 2);
  assert.equal(j.ward, '北区');
});

test('[35P] 完全なLOD3をLOD3として優先する', () => {
  const j = judgeBuilding(building('lod3', 3));
  assert.equal(j.lod3.present, true);
  assert.equal(j.lod3.complete, true);
  assert.equal(j.chosen, 3);
});

test('[35P] 屋根だけの高LODを採用しない', () => {
  const src = `<bldg:Building gml:id="bad"><bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>${surf('RoofSurface','r',2)}</bldg:Building>`;
  const j = judgeBuilding(src);
  assert.equal(j.lod2.present, true);
  assert.equal(j.lod2.complete, false);
  assert.equal(j.chosen, 1);
});
