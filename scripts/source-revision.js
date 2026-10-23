// Source revision recorded in <binary>.build.json. A build from a checkout with
// modified tracked files is marked "-dirty" so it can never pass as the clean
// commit: server-bootstrap.sh reuses a cached connector only on an exact match.
import {spawnSync} from 'node:child_process';
export function sourceRevision(root,git=(...a)=>spawnSync('git',a,{cwd:root,encoding:'utf8'})){
  const head=git('rev-parse','HEAD'),status=git('status','--porcelain','--untracked-files=no');
  if(head.status!==0||!/^[0-9a-f]{40,64}$/.test(head.stdout.trim()))return 'unknown';
  return head.stdout.trim()+(status.status===0&&!status.stdout.trim()?'':'-dirty');
}
