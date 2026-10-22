#!/usr/bin/env python3
"""User-operated Linux TTY test; no actual login during preparation/tests."""
import argparse, hashlib, json, os, pathlib, re, select, signal, subprocess, sys, time
from qq_private_test import PrivateDirectory, TestError, hidden, require_terminal, stop_children, tunnel_args

WHEEL_SHA='16e64e0716c14960108e85d853062c9e8bba5ca8252c0b4d0231b9df4060ff4f'
def render_qr(content, out=None):
    if not isinstance(content,str) or not 1<=len(content)<=2048:
        raise TestError('invalid_qr_content')
    wheel=pathlib.Path(__file__).resolve().parents[1]/'vendor/qrcode-8.2-py3-none-any.whl'
    if hashlib.sha256(wheel.read_bytes()).hexdigest()!=WHEEL_SHA:
        raise TestError('qr_dependency_hash_mismatch')
    if str(wheel) not in sys.path: sys.path.insert(0,str(wheel))
    import qrcode
    qr=qrcode.QRCode(border=4);qr.add_data(content);qr.make(fit=True)
    qr.print_ascii(out=out or sys.stdout,invert=True)

def phone_code(deadline):
    import termios
    require_terminal();fd=sys.stdin.fileno();old=termios.tcgetattr(fd);new=list(old);new[3]&=~termios.ECHO
    try:
        termios.tcsetattr(fd,termios.TCSANOW,new)
        print('Enter the digits shown by your phone (hidden): ',end='',flush=True)
        if not select.select([sys.stdin],[],[],max(0,deadline-time.monotonic()))[0]:
            raise TestError('test_timeout')
        value=sys.stdin.readline(64).strip()
        if not re.fullmatch('[0-9]{1,12}',value):raise TestError('invalid_verify_code')
        return value
    finally:
        termios.tcsetattr(fd,termios.TCSANOW,old);print('',flush=True)

def run(args):
    require_terminal()
    if sys.platform!='linux':raise TestError('linux_required')
    import fcntl,resource
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
    if not 1<=args.maximum_seconds<=1800:raise TestError('invalid_test_duration')
    for value in [args.tunnel_id,args.organization_id]:
        if not re.fullmatch('[A-Za-z0-9_-]{1,128}',value):raise TestError('invalid_identifier')
    for binary in [args.node,args.tunnel_client]:
        if not binary.is_absolute() or not binary.is_file():raise TestError('absolute_binary_required')
    # Never compete for the existing Tunnel while a QQ test is using it.
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit():continue
        try:
            if (proc/'exe').resolve()==args.tunnel_client.resolve():raise TestError('existing_tunnel_client_running')
        except OSError:pass
    session=PrivateDirectory(args.parent);children=[];old={}
    try:
        lockfd=os.open(args.parent/'.weixin-test.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        with os.fdopen(lockfd,'a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise TestError('test_already_running') from None
            key=hidden('Existing Tunnel Read+Use runtime key (hidden): ')
            import secrets
            bearer=secrets.token_urlsafe(48)
            env={'PATH':'/usr/bin:/bin','HOME':str(session.path),'TMPDIR':str(session.path),'XDG_CONFIG_HOME':str(session.path/'config'),'XDG_CACHE_HOME':str(session.path/'cache'),'GOMEMLIMIT':'100MiB','GOMAXPROCS':'1'}
            def interrupted(*_):raise KeyboardInterrupt
            for sig in [signal.SIGHUP,signal.SIGTERM]:old[sig]=signal.signal(sig,interrupted)
            script=pathlib.Path(__file__).resolve().parents[1]/'bin/weixin-test-session.js'
            node=subprocess.Popen([str(args.node),'--max-old-space-size=96',str(script)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
            children.append(node)
            node.stdin.write((json.dumps({'bearer':bearer,'dataDir':str(session.path/'data'),'maximumSeconds':args.maximum_seconds})+'\n').encode());node.stdin.flush()
            deadline=time.monotonic()+args.maximum_seconds;buffer=b'';bound=False;started=False
            print(json.dumps({'stage':'started','platform':'weixin','session_directory':str(session.path),'maximum_seconds':args.maximum_seconds}),flush=True)
            while time.monotonic()<deadline:
                if any(c.poll() is not None for c in children[1:]):raise TestError('tunnel_client_exited')
                ready,_,_=select.select([node.stdout,sys.stdin],[],[],min(.5,max(0,deadline-time.monotonic())))
                if sys.stdin in ready:
                    line=sys.stdin.readline(128)
                    if not line or line.strip()=='STOP':break
                if node.stdout not in ready:continue
                chunk=os.read(node.stdout.fileno(),4096)
                if not chunk:break
                buffer+=chunk
                if len(buffer)>16384:raise TestError('session_output_limit')
                while b'\n' in buffer:
                    raw,buffer=buffer.split(b'\n',1);event=json.loads(raw);stage=event.get('stage')
                    if stage=='qr':
                        print('Scan this QR with your own WeChat and confirm on your phone. Do not share it.',flush=True)
                        render_qr(event.get('content'));sys.stdout.flush()
                    elif stage=='verify_code_required':
                        value=phone_code(min(deadline,time.monotonic()+120))
                        node.stdin.write((value+'\n').encode());node.stdin.flush();del value
                    elif stage=='owner_bound':
                        if event.get('source')!='official_confirmed' or bound:raise TestError('invalid_owner_binding')
                        bound=True;print(json.dumps({'stage':'owner_bound','source':'official_confirmed'}),flush=True)
                    elif stage=='gateway_ready':
                        if not bound or started:raise TestError('unbound_gateway')
                        client_env={**env,'CONTROL_PLANE_API_KEY':key,'CONTROL_PLANE_TUNNEL_ID':args.tunnel_id,'CONTROL_PLANE_ORGANIZATION_ID':args.organization_id,'DOT_MCP_AUTH':'Bearer '+bearer}
                        client=subprocess.Popen(tunnel_args(args.tunnel_client,event.get('url','')),env=client_env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
                        children.append(client);started=True;del client_env,key,bearer
                        print(json.dumps({'stage':'gateway_ready','platform':'weixin','tools':['gateway_status','list_pending','read_message','reply'],'subscriptions':False}),flush=True)
                    elif stage=='progress':
                        phase=event.get('phase')
                        if phase not in ['weixin_qr_request','weixin_wait','weixin_scaned','weixin_scaned_but_redirect']:raise TestError('invalid_progress')
                        print(json.dumps({'stage':'progress','phase':phase}),flush=True)
                    elif stage=='failed':
                        code=event.get('code','')
                        allowed={'weixin_http_rejected','weixin_rate_limit','weixin_server_error','weixin_invalid_response','weixin_rejected','weixin_invalid_credentials','weixin_verify_limit','weixin_invalid_verify_code','weixin_origin_denied','weixin_qr_expired','weixin_qr_verify_code_blocked','weixin_qr_binded_redirect','weixin_unknown_login_status','weixin_login_timeout','weixin_test_failed','network_before_connect','network_failure','dns_timeout','non_public_destination','destination_denied'}
                        raise TestError(code if code in allowed else 'weixin_test_failed')
                    elif stage=='gateway_stopped':break
                    else:raise TestError('unexpected_stage')
    finally:
        for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:
            if sig not in old:old[sig]=signal.getsignal(sig)
            signal.signal(sig,signal.SIG_IGN)
        try:
            stop_children(children);session.cleanup()
            print(json.dumps({'stage':'stopped','processes_remaining':False,'data_removed':True,'gateway_exit_code':children[0].returncode if children else None,'tunnel_exit_code':children[1].returncode if len(children)>1 else None}),flush=True)
        finally:
            for sig,handler in old.items():signal.signal(sig,handler)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['parent','node','tunnel-client']:p.add_argument('--'+name,type=pathlib.Path,required=True)
    for name in ['tunnel-id','organization-id']:p.add_argument('--'+name,required=True)
    p.add_argument('--maximum-seconds',type=int,default=1800)
    try:run(p.parse_args())
    except KeyboardInterrupt:return 0
    except TestError as e:print(json.dumps({'stage':'failed','code':str(e)}));return 1
    except Exception:print(json.dumps({'stage':'failed','code':'unexpected_failure'}));return 1
    return 0
if __name__=='__main__':sys.exit(main())
