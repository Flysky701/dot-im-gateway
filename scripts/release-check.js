import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
if(Number(process.versions.node.split('.')[0])!==24)throw new Error('Node 24 required');
for(const args of [['scripts/check.js'],['--test']]){const r=spawnSync(process.execPath,args,{cwd,stdio:'inherit'});if(r.status)process.exit(r.status);}
