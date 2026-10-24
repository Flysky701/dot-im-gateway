// Build host dependencies only. The resulting executable needs no Node/Python/npm.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import postject from 'postject';
import {sourceRevision} from '../scripts/source-revision.js';
const root=fileURLToPath(new URL('..',import.meta.url)),pkg=path.join(root,'packaging');
if(process.versions.node!=='24.21.0'||process.arch!=='x64'||!['win32','linux'].includes(process.platform))throw new Error('fixed_build_runtime_required');
const work=path.join(pkg,'work',process.platform),cache=path.join(pkg,'cache',process.platform),dist=path.join(root,'dist');
fs.mkdirSync(work,{recursive:true});fs.mkdirSync(dist,{recursive:true});
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,stdio:'inherit'});if(r.status!==0)throw new Error('build_step_failed');};
const hash=b=>createHash('sha256').update(b).digest('hex');
await build({entryPoints:[path.join(pkg,'entry.js')],bundle:true,platform:'node',format:'cjs',target:'node24',outfile:path.join(work,'entry.cjs'),logLevel:'warning'});
await build({entryPoints:[path.join(pkg,'browser.js')],bundle:true,platform:'browser',format:'iife',minify:true,outfile:path.join(work,'browser.js'),logLevel:'warning'});
await build({entryPoints:[path.join(pkg,'qq-worker.js')],bundle:true,platform:'node',format:'cjs',target:'node24',outfile:path.join(work,'qq-worker.cjs'),logLevel:'warning'});
const binary=fs.readFileSync(path.join(cache,process.platform==='win32'?'tunnel-client.exe':'tunnel-client'));
fs.writeFileSync(path.join(work,'tunnel.gz'),gzipSync(binary,{level:9}));
const source=sourceRevision(root);
const manifest={platform:process.platform,arch:process.arch,node:process.versions.node,tunnelVersion:'0.0.17',tunnelSha256:hash(binary),sourceCommit:source};
fs.writeFileSync(path.join(work,'manifest.json'),JSON.stringify(manifest));
const notices=['LICENSE','docs/THIRD_PARTY_NOTICES.md','licenses/qrcode-generator-MIT.txt'].map(x=>fs.readFileSync(path.join(root,x),'utf8'));
notices.push('Tencent qqbot-connector 1.2.0 — UNLICENSED; private integration authorized by the project owner. No MIT redistribution grant is asserted.');
notices.push(fs.readFileSync(path.join(pkg,'node_modules/@tencent-connect/qqbot-connector/package.json'),'utf8'));
notices.push(fs.readFileSync(path.join(pkg,'node_modules/@tencent-connect/qqbot-connector/README.md'),'utf8'));
notices.push(fs.readFileSync(path.join(pkg,'node_modules/qrcode-terminal/LICENSE'),'utf8'));
notices.push('qrcode-terminal includes QRCode for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT. Original attribution:');
notices.push(fs.readFileSync(path.join(pkg,'node_modules/qrcode-terminal/vendor/QRCode/index.js'),'utf8').split('var QR8bitByte')[0]);
for(const file of ['node-LICENSE','tunnel-LICENSE','tunnel-NOTICE','tunnel-dependencies.txt'])notices.push(fs.readFileSync(path.join(cache,file),'utf8'));
fs.writeFileSync(path.join(work,'licenses.txt'),notices.join('\n\n---\n\n'));
const config={main:path.join(work,'entry.cjs'),output:path.join(work,'sea.blob'),disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false,execArgvExtension:'none',assets:{html:path.join(root,'web/connect.html'),css:path.join(root,'web/connect.css'),js:path.join(work,'browser.js'),'tunnel.gz':path.join(work,'tunnel.gz'),manifest:path.join(work,'manifest.json'),licenses:path.join(work,'licenses.txt')}};
config.assets['qq-sdk']=path.join(work,'qq-worker.cjs');
fs.writeFileSync(path.join(work,'sea.json'),JSON.stringify(config));run(process.execPath,['--experimental-sea-config',path.join(work,'sea.json')]);
const target=path.join(dist,'dot-im-connect-'+process.platform+'-x64'+(process.platform==='win32'?'.exe':''));fs.copyFileSync(process.execPath,target);
// An injected binary cannot keep Node's original Authenticode signature. Remove
// its certificate table before injection; the output is explicitly unsigned.
if(process.platform==='win32'){
  const pe=fs.readFileSync(target),offset=pe.readUInt32LE(0x3c)+24;
  if(pe.readUInt16LE(offset)!==0x20b)throw new Error('expected_pe32_plus');
  const security=offset+112+4*8,start=pe.readUInt32LE(security),size=pe.readUInt32LE(security+4);
  if(start&&start+size>pe.length)throw new Error('invalid_certificate_table');
  pe.writeUInt32LE(0,security);pe.writeUInt32LE(0,security+4);
  fs.writeFileSync(target,start&&start+size===pe.length?pe.subarray(0,start):pe);
}
await postject.inject(target,'NODE_SEA_BLOB',fs.readFileSync(config.output),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'});fs.chmodSync(target,0o700);
run(target,['--self-test']);
fs.writeFileSync(target+'.sha256',hash(fs.readFileSync(target))+'  '+path.basename(target)+'\n');
fs.writeFileSync(target+'.build.json',JSON.stringify({...manifest,executableSha256:hash(fs.readFileSync(target)),bytes:fs.statSync(target).size},null,2)+'\n');
console.log(JSON.stringify({built:path.basename(target),bytes:fs.statSync(target).size}));
