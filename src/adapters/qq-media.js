import {ensure,str,Fault} from '../util.js';
import {safeURL} from '../network.js';
import {safeMediaName,declaredMediaType} from '../media.js';

// Exact Tencent attachment hosts only. No tool argument can extend this list.
export const QQ_ATTACHMENT_HOSTS=Object.freeze(['multimedia.nt.qq.com.cn','multimedia.nt.qq.com','gchat.qpic.cn','c2cpicdw.qpic.cn']);
export async function receiveQQMedia(messageId,attachments,media,send,downloadToken){
  const files=[];
  for(const attachment of attachments){
    const name=safeMediaName(attachment?.filename),mime=declaredMediaType(attachment?.content_type);
    try{
      ensure(attachment&&typeof attachment==='object'&&!Array.isArray(attachment),'invalid_attachment');
      const claimed=attachment.size===undefined?undefined:Number(attachment.size);
      if(claimed!==undefined)ensure(Number.isSafeInteger(claimed)&&claimed>0&&claimed<=media.config.maxMediaBytes,'media_size_limit');
      let url=str(attachment.url,8192);if(url.startsWith('//'))url='https:'+url;
      const parsed=safeURL(url,QQ_ATTACHMENT_HOSTS);
      // The transport pins public IPv4 and does not follow redirects. Start
      // anonymously; only QQ's exact multimedia download endpoint may need auth.
      const options={hosts:QQ_ATTACHMENT_HOSTS,method:'GET',headers:{},limit:media.config.maxMediaBytes,timeout:20000};
      let r=await send(url,options);
      if((r.status===401||r.status===403)&&parsed.hostname==='multimedia.nt.qq.com.cn'&&parsed.pathname==='/download'&&downloadToken){
        const token=await downloadToken();
        r=await send(url,{...options,headers:{Authorization:`QQBot ${token}`}});
      }
      if(r.status===401||r.status===403)throw new Fault('attachment_download_auth_required');
      if(r.status>=300&&r.status<400)throw new Fault('attachment_redirect_rejected');
      ensure(r.status===200,'attachment_download_rejected');
      ensure(Buffer.isBuffer(r.body)&&r.body.length>0&&r.body.length<=media.config.maxMediaBytes,'media_size_limit');
      if(claimed!==undefined)ensure(claimed===r.body.length,'media_length_mismatch');
      const saved=media.putQQ(messageId,r.body,mime,name);
      files.push({...saved,status:'available'});
    }catch(e){
      // Do not echo signed URLs, raw exceptions or credentials. One failed file
      // must not suppress text or other attachments in the same owner message.
      files.push({name,mime,status:'failed',error:e instanceof Fault?e.code:'attachment_download_failed'});
    }
  }
  return files;
}
