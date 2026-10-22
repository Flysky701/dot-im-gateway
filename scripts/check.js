import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(dir,x.name)):[path.join(dir,x.name)]);}
for(const file of ['src','bin','scripts','test'].flatMap(walk).filter(f=>f.endsWith('.js'))){const p=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(p.status)process.exit(p.status);}
console.log('Syntax checks passed.');
const skill='skills/deploy-dot-im-gateway/SKILL.md';const text=fs.readFileSync(skill,'utf8');
if(!/^---\nname: deploy-dot-im-gateway\ndescription: .+\n---\n/.test(text))throw new Error('Invalid skill frontmatter');
for(const [,link] of text.matchAll(/\]\(([^)]+)\)/g))if(!link.startsWith('http')&&!fs.existsSync(path.resolve(path.dirname(skill),link)))throw new Error('Missing skill reference');
console.log('Skill frontmatter and referenced paths checked (no external YAML validator).');
