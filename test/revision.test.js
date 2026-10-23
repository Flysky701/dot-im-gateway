import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sourceRevision} from '../scripts/source-revision.js';

test('build records a dirty checkout so it is never reused as the clean commit',{skip:spawnSync('git',['--version']).status!==0&&'git not installed'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dot-im-rev-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...a)=>{const r=spawnSync('git',['-c','user.name=t','-c','user.email=t@t',...a],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  assert.equal(sourceRevision(root),'unknown');
  git('init','-q');fs.writeFileSync(path.join(root,'a.js'),'1\n');git('add','a.js');git('commit','-qm','x');
  const head=git('rev-parse','HEAD');
  assert.equal(sourceRevision(root),head);
  fs.writeFileSync(path.join(root,'untracked.txt'),'ignored\n');assert.equal(sourceRevision(root),head);
  fs.writeFileSync(path.join(root,'a.js'),'2\n');assert.equal(sourceRevision(root),head+'-dirty');
  git('add','a.js');assert.equal(sourceRevision(root),head+'-dirty','staged changes count too');
  git('checkout','-q','--','.');git('reset','-q','--hard');assert.equal(sourceRevision(root),head);
  assert.equal(sourceRevision(root,()=>({status:1,stdout:''})),'unknown');
});
