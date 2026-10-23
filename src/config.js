import fs from 'node:fs';
import path from 'node:path';
import {ensure, str, exact} from './util.js';
export const example = {
  mode: 'offline', host: '127.0.0.1', port: 8788, dataDir: './runtime', principal: 'owner',
  tokenEnv: 'DOT_GATEWAY_TOKEN', allowSubscriptions: false, callbackHosts: [],
  maxMediaBytes: 4194304, maxStoredMediaBytes: 268435456, mediaRetentionHours: 168,
  conversation: {debounceMs: 2000, maxWaitMs: 8000},
  qq: {enabled: false, ownerId: '', appId: '', secretEnv: 'DOT_QQ_SECRET', apiProfile: 'documented', gatewayHosts: [], replyTtlMs: 240000},
  weixin: {enabled: false, ownerId: '', botId: '', tokenEnv: 'DOT_WEIXIN_TOKEN', apiHost: 'ilinkai.weixin.qq.com', cdnHost: 'novac2c.cdn.weixin.qq.com', replyTtlMs: 86400000}
};
export function validate(c) {
  exact(c, Object.keys(example));
  c.conversation ??= {...example.conversation};
  exact(c.conversation, Object.keys(example.conversation));
  ensure(Number.isInteger(c.conversation.debounceMs)&&c.conversation.debounceMs>=0&&c.conversation.debounceMs<=5000,'invalid_debounce');
  ensure(Number.isInteger(c.conversation.maxWaitMs)&&c.conversation.maxWaitMs>=c.conversation.debounceMs&&c.conversation.maxWaitMs<=15000,'invalid_batch_wait');
  ensure(['offline','live'].includes(c.mode) && c.host === '127.0.0.1', 'loopback_required');
  ensure(Number.isInteger(c.port) && c.port >= 1024 && c.port <= 65535);
  str(c.principal); str(c.dataDir, 2048); str(c.tokenEnv);
  ensure(typeof c.allowSubscriptions === 'boolean');
  ensure(Array.isArray(c.callbackHosts) && c.callbackHosts.every(h => /^[a-z0-9.-]+$/.test(h)));
  ensure(Number.isInteger(c.maxMediaBytes) && c.maxMediaBytes >= 1024 && c.maxMediaBytes <= 4*1024*1024);
  ensure(Number.isInteger(c.maxStoredMediaBytes) && c.maxStoredMediaBytes >= c.maxMediaBytes);
  ensure(Number.isFinite(c.mediaRetentionHours) && c.mediaRetentionHours >= 1);
  for (const p of ['qq','weixin']) {
    exact(c[p], Object.keys(example[p]));
    ensure(typeof c[p].enabled === 'boolean');
    ensure(Number.isInteger(c[p].replyTtlMs) && c[p].replyTtlMs > 0 && c[p].replyTtlMs <= (p === 'qq' ? 300000 : 86400000));
    if(c[p].enabled) { str(c[p].ownerId); str(p === 'qq' ? c[p].appId : c[p].botId); }
  }
  ensure(['documented','tencent-sdk'].includes(c.qq.apiProfile));
  ensure(Array.isArray(c.qq.gatewayHosts) && c.qq.gatewayHosts.every(h => /^[a-z0-9.-]+$/.test(h)));
  ensure(/^(?:[a-z0-9-]+\.)*weixin\.qq\.com$/.test(c.weixin.apiHost));
  ensure(/^(?:[a-z0-9-]+\.)*cdn\.weixin\.qq\.com$/.test(c.weixin.cdnHost));
  for(const name of [c.tokenEnv,c.qq.secretEnv,c.weixin.tokenEnv]) ensure(/^[A-Z][A-Z0-9_]+$/.test(name));
  return c;
}
export function readConfig(file) { const c = validate(JSON.parse(fs.readFileSync(file,'utf8'))); c.dataDir = path.resolve(path.dirname(file),c.dataDir); return c; }
export function secret(name) { const s=process.env[name]; ensure(typeof s === 'string' && s.length >= 16 && !/[\r\n]/.test(s),'missing_runtime_secret'); return s; }
export function privateDir(dir) { fs.mkdirSync(dir,{recursive:true,mode:0o700}); ensure(!fs.lstatSync(dir).isSymbolicLink(),'unsafe_data_directory'); if(process.platform !== 'win32') ensure((fs.statSync(dir).mode & 0o077) === 0,'private_permissions_required'); }
