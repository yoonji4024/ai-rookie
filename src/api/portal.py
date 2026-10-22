"""Private web portal: authenticated viewers, consent-based family links and reports.

Wraps the existing analysis functions without changing their model/reference rules.
No display-name based access and no fabricated report when history is empty.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from src.api.schema import TTSRequest, EmpathyRequest
from src.api.schema import ReportResponse, Interpretation
from src.api.conversation_memory import install_memory_routes, memory_prompts, NEXT_MEETINGS
from src.api.portal_explanation import generate_portal_explanation, factual_explanation

COOKIE = 'earlyear_session'
ORIGINS = {'http://127.0.0.1:5173', 'http://localhost:5173'}
CATALOG_PATH = Path(__file__).resolve().parents[2] / 'configs/content/team_video_questions.v1.json'
# Preserve authored originals; these specific leading/ambiguous premises await review.
HELD_IDS = {'a2GT6K5yzAY-q2','a2GT6K5yzAY-q8','VnuBn-jdNv8-q5','VnuBn-jdNv8-q8'}
CLOSING_INVITATIONS = {
    'q-2EmyuAOmM-q9': '저는 보고 나니 마음이 따뜻해졌어요. 어떤 장면이 기억에 남으셨어요? 처음부터 생각나는 대로 같이 이야기해 볼까요?',
    'mt7CuNcNXvk-q10': '저는 보는 동안 함께 설레는 기분이었어요. 어떤 장면이 기억에 남으셨어요? 처음부터 생각나는 대로 같이 이야기해 볼까요?',
}


def select_prompts(video, segment, rng=None):
    rng = rng or secrets.SystemRandom()
    pool = [q for q in video['questions'] if q['segmentId'] == segment['id'] and q['id'] not in HELD_IDS]
    rng.shuffle(pool)
    # Reserve one existing end-of-video prompt; never invent reference answers.
    after = [q for q in pool if q['delivery']=='after_video' or q['timestamp']==0]
    order_recall = [q for q in after if '순서' in q['question']]
    selected = [(order_recall or after)[0]] if after else []
    length = (segment.get('end') or 0) - (segment.get('start') or 0)
    # Unknown-length news also uses the conservative one-interruption limit.
    during_limit = 1 if 0 < length <= 180 or video.get('category')=='news' and not length else 3
    for q in pool:
        if q in selected or q in after:
            continue
        if sum(x['delivery']=='at_time' and x['timestamp']!=0 for x in selected) >= during_limit:
            break
        t = q['timestamp']
        # During-play interruptions need breathing room. End conversations can queue.
        if q['delivery'] == 'at_time' and t and any(
            other['delivery'] == 'at_time' and other['timestamp']
            and abs(t-other['timestamp']) < 20 for other in selected
        ):
            continue
        selected.append(q)
        if len(selected) == 4:
            break
    def order(q):
        if q['delivery'] == 'after_video' or q['timestamp'] == 0:
            return (float('inf'),q['number'])
        return (q['timestamp'] if q['timestamp'] is not None else segment['end'],q['number'])
    return sorted(selected,key=order)


def public_prompt(q, segment):
    # Only new sessions freeze revised wording; existing plans retain what was shown.
    text = q.get('displayQuestion', q['question']).replace('어르신은 ', '').replace('어르신도 ', '').replace('어르신께는 ', '').replace('따님한테', '가까운 분께').replace('손주분한테', '가까운 분께')
    text = text.replace('말씀해 주세요.', '들려주세요.')
    return {'id':q['id'],'question':text,'timestamp':q['timestamp'] if q['timestamp'] is not None else segment['end'],
            'delivery':'after_video' if q['timestamp']==0 else q['delivery'], 'maxRecordingMs':60000}


class Credentials(BaseModel):
    username: str = Field(min_length=2,max_length=50,pattern=r'^[A-Za-z0-9가-힣_.-]+$')
    password: str = Field(min_length=8,max_length=128)
    role: Literal['user','guardian']
    displayName: str = Field(default='',max_length=40)

class Login(BaseModel):
    username: str = Field(min_length=2,max_length=50)
    password: str = Field(min_length=1,max_length=128)

class Connect(BaseModel):
    code: str = Field(min_length=12,max_length=24)

class IdentifiedConnect(Connect):
    memberIdentity: str = Field(min_length=1,max_length=50)

class FamilyCredentials(IdentifiedConnect):
    username: str = Field(min_length=2,max_length=50,pattern=r'^[A-Za-z0-9가-힣_.-]+$')
    password: str = Field(min_length=8,max_length=128)

class StartWatch(BaseModel):
    videoId: str
    segmentId: str


def create_portal(backend, root: Path, *, extension_origins=()):
    # Opt-in only: the established web portal has no new trusted origin by default.
    extension_origins = frozenset(extension_origins)
    if any(not __import__('re').fullmatch(r'chrome-extension://[a-p]{32}', o) for o in extension_origins):
        raise ValueError('Invalid extension origin')
    extension_ids = {o.rsplit('/', 1)[-1] for o in extension_origins}
    root.mkdir(parents=True, exist_ok=True,mode=0o700)
    db_path=root/'portal.sqlite3'
    @contextmanager
    def db():
        conn=sqlite3.connect(db_path,timeout=15)
        conn.row_factory=sqlite3.Row
        try:
            with conn: yield conn
        finally: conn.close()
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, role TEXT, salt TEXT, password_hash TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS extension_sessions(token_hash TEXT PRIMARY KEY, extension_origin TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY, owner_id TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS links(owner_id TEXT, family_id TEXT, PRIMARY KEY(owner_id,family_id));
        CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY, owner_id TEXT, video_id TEXT, segment_id TEXT, plan TEXT, created REAL, status TEXT, report TEXT);
        CREATE TABLE IF NOT EXISTS report_explanation_jobs(watch_id TEXT PRIMARY KEY, status TEXT NOT NULL);
        ''')
    db_path.chmod(0o600)
    app=FastAPI(title='EarlyEar private portal')
    app.state.db_path=db_path
    catalog=json.loads(CATALOG_PATH.read_text())
    by_id={v['id']:v for v in catalog['videos'] if v['youtubeId']}
    attempts={}
    def digest(text):return hashlib.sha256(text.encode()).hexdigest()
    def view(row):return {'id':row['id'],'username':row['username'],'displayName':row['display_name'],'role':row['role']}
    def extension_request(req):
        origin = req.headers.get('origin')
        if origin in extension_origins:
            return origin
        # Chrome privileged fetch can omit Origin; preflight from other web origins
        # still fails the exact-origin CORS policy and never grants a session.
        ident = req.headers.get('x-memflix-extension')
        if origin is None and ident in extension_ids:
            return 'chrome-extension://' + ident
        return None
    def request_token(req):
        authorization = req.headers.get('authorization')
        if authorization is not None:
            if not extension_request(req) or not authorization.startswith('Bearer '):
                raise HTTPException(401, '다시 로그인해 주세요.')
            return authorization[7:]
        return '' if extension_request(req) else req.cookies.get(COOKIE, '')
    def user(req,role=None):
        token=request_token(req)
        with db() as c:
            row=c.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?',(digest(token),time.time())).fetchone()
            ext=c.execute('SELECT extension_origin FROM extension_sessions WHERE token_hash=?',(digest(token),)).fetchone()
        if row is None:raise HTTPException(401,'로그인이 필요해요.')
        if ext is not None:
            permitted = {'/api/account/me', '/api/account/logout', '/api/welcome', '/api/welcome/start',
                         '/api/welcome/finish', '/api/watch', '/api/report', '/api/transcribe', '/api/tts',
                         '/api/extension/catalog', '/api/extension/watch-state', '/api/memory', '/api/memory/clear'}
            if (req.headers.get('authorization') is None or ext['extension_origin'] != extension_request(req)
                    or req.url.path not in permitted or row is None or row['role'] != 'user'):
                raise HTTPException(403, '이 연결에서는 사용할 수 없어요.')
        elif req.headers.get('authorization') is not None:
            raise HTTPException(401, '다시 로그인해 주세요.')
        if row is None:raise HTTPException(401,'로그인이 필요해요.')
        if role and row['role']!=role:raise HTTPException(403,'이 계정에서는 사용할 수 없어요.')
        return row
    def session(response,uid):
        token=secrets.token_urlsafe(32)
        with db() as c:c.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),uid,time.time()+12*3600))
        response.set_cookie(COOKIE,token,httponly=True,samesite='strict',max_age=12*3600,path='/')
    def allowed(c,viewer,owner):
        return viewer['id']==owner or c.execute('SELECT 1 FROM links WHERE owner_id=? AND family_id=?',(owner,viewer['id'])).fetchone() is not None
    def throttle(key):
        now=time.time();recent=[t for t in attempts.get(key,[]) if t>now-600]
        if len(recent)>=10:raise HTTPException(429,'잠시 후 다시 시도해 주세요.')
        attempts[key]=recent+[now]
    def identified_invite(c,body):
        # Resolve only within a consent code, never list accounts by display name.
        normalized=''.join(body.code.split()).replace('-','').upper()
        invite=c.execute('''SELECT i.code_hash,i.owner_id,u.username,u.display_name
                            FROM invites i JOIN users u ON u.id=i.owner_id
                            WHERE i.code_hash=? AND i.expires>? AND u.role='user' ''',
                         (digest(normalized),time.time())).fetchone()
        identity=body.memberIdentity.strip()
        if invite is None or not identity or not (
            identity.casefold()==invite['username'] or identity==invite['display_name']
        ):
            raise HTTPException(400,'연결할 사용자의 아이디·이름과 공유 코드를 함께 확인해 주세요.')
        return invite
    @app.middleware('http')
    async def origin_guard(req,call_next):
        if req.method not in {'GET','HEAD','OPTIONS'} and req.headers.get('origin') not in ORIGINS and not extension_request(req):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail':'요청한 화면의 주소를 확인해 주세요.'},status_code=403)
        result=await call_next(req)
        result.headers['Cache-Control']='no-store'
        result.headers['X-Content-Type-Options']='nosniff'
        return result
    if extension_origins:
        from fastapi.middleware.cors import CORSMiddleware
        app.add_middleware(CORSMiddleware, allow_origins=sorted(extension_origins),
                           allow_methods=['GET','POST'], allow_headers=['Authorization','Content-Type','X-Memflix-Extension'])
    @app.post('/api/extension/login')
    def extension_login(body:Login,req:Request):
        origin=extension_request(req)
        if not origin:raise HTTPException(403, '연결할 확장을 확인해 주세요.')
        key=('login',req.client.host if req.client else 'local',body.username.casefold());throttle(key)
        with db() as c:row=c.execute('SELECT * FROM users WHERE username=?',(body.username.casefold(),)).fetchone()
        salt=bytes.fromhex(row['salt']) if row else b'\0'*16
        hashed=hashlib.pbkdf2_hmac('sha256',body.password.encode(),salt,600000).hex()
        if row is None or not hmac.compare_digest(hashed,row['password_hash']):raise HTTPException(401, '아이디와 비밀번호를 확인해 주세요.')
        if row['role']!='user':raise HTTPException(403, '패밀리 계정은 웹사이트에서 이용해 주세요.')
        token=secrets.token_urlsafe(32)
        with db() as c:
            c.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),row['id'],time.time()+12*3600))
            c.execute('INSERT INTO extension_sessions VALUES(?,?)',(digest(token),origin))
        attempts.pop(key,None)
        return {'token':token,'account':view(row),'expiresIn':12*3600}
    @app.get('/api/extension/catalog')
    def extension_catalog(req:Request):
        user(req,'user')
        return [{'id':v['id'],'title':v['title'],'segments':v['segments']} for v in by_id.values()]
    @app.get('/api/extension/watch-state')
    def extension_watch_state(req:Request,watchId:str):
        who=user(req,'user')
        with db() as c:row=c.execute('SELECT status FROM watches WHERE id=? AND owner_id=?',(watchId,who['id'])).fetchone()
        if row is None:raise HTTPException(404, '기록을 찾을 수 없어요.')
        return {'state':row['status']}
    @app.get('/api/health')
    def health():return {**backend._health(),'portal':True}
    @app.post('/api/account/register')
    def register(body:Credentials,req:Request,response:Response):
        throttle(('register',req.client.host if req.client else 'local'))
        salt=secrets.token_hex(16);uid=secrets.token_hex(16)
        pw=hashlib.pbkdf2_hmac('sha256',body.password.encode(),bytes.fromhex(salt),600000).hex()
        try:
            with db() as c:c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',(uid,body.username.casefold(),body.displayName.strip() or body.username,body.role,salt,pw))
        except sqlite3.IntegrityError:raise HTTPException(409,'다른 아이디를 사용해 주세요.')
        session(response,uid)
        with db() as c:return view(c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())
    @app.post('/api/account/register-family')
    def register_family(body:FamilyCredentials,req:Request,response:Response):
        throttle(('register',req.client.host if req.client else 'local'))
        salt=secrets.token_hex(16);uid=secrets.token_hex(16)
        pw=hashlib.pbkdf2_hmac('sha256',body.password.encode(),bytes.fromhex(salt),600000).hex()
        try:
            with db() as c:
                c.execute('BEGIN IMMEDIATE')
                invite=identified_invite(c,body)
                # Family login identity remains their own account, not the viewer's name.
                c.execute('INSERT INTO users(id,username,display_name,role,salt,password_hash) VALUES(?,?,?,?,?,?)',
                          (uid,body.username.casefold(),body.username,'guardian',salt,pw))
                c.execute('INSERT INTO links VALUES(?,?)',(invite['owner_id'],uid))
                c.execute('DELETE FROM invites WHERE code_hash=?',(invite['code_hash'],))
        except sqlite3.IntegrityError:raise HTTPException(409,'다른 로그인 아이디를 사용해 주세요.')
        session(response,uid)
        with db() as c:return view(c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())
    @app.post('/api/account/login')
    def login(body:Login,req:Request,response:Response):
        key=('login',req.client.host if req.client else 'local',body.username.casefold());throttle(key)
        with db() as c:row=c.execute('SELECT * FROM users WHERE username=?',(body.username.casefold(),)).fetchone()
        salt=bytes.fromhex(row['salt']) if row else b'\0'*16
        hashed=hashlib.pbkdf2_hmac('sha256',body.password.encode(),salt,600000).hex()
        if row is None or not hmac.compare_digest(hashed,row['password_hash']):raise HTTPException(401,'아이디와 비밀번호를 확인해 주세요.')
        attempts.pop(key,None);session(response,row['id']);return view(row)
    @app.get('/api/account/me')
    def me(req:Request):return view(user(req))
    @app.post('/api/account/logout')
    def logout(req:Request,response:Response):
        token_hash=digest(request_token(req))
        with db() as c:
            c.execute('DELETE FROM sessions WHERE token_hash=?',(token_hash,))
            c.execute('DELETE FROM extension_sessions WHERE token_hash=?',(token_hash,))
        response.delete_cookie(COOKIE,path='/');return {'ok':True}
    @app.post('/api/family/code')
    def issue_code(req:Request):
        owner=user(req,'user');code=secrets.token_hex(6).upper()
        with db() as c:
            c.execute('DELETE FROM invites WHERE owner_id=?',(owner['id'],))
            c.execute('INSERT INTO invites VALUES(?,?,?)',(digest(code),owner['id'],time.time()+900))
        return {'code':code,'expiresIn':900}
    @app.post('/api/family/connect')
    def connect(body:Connect,req:Request):
        family=user(req,'guardian');throttle(('code',family['id']))
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            invite=c.execute('SELECT * FROM invites WHERE code_hash=? AND expires>?',(digest(body.code.replace('-','').strip().upper()),time.time())).fetchone()
            if invite is None:raise HTTPException(400,'연결 코드가 없거나 만료되었어요.')
            c.execute('INSERT OR IGNORE INTO links VALUES(?,?)',(invite['owner_id'],family['id']))
            c.execute('DELETE FROM invites WHERE code_hash=?',(invite['code_hash'],))
        return {'ok':True}
    @app.post('/api/family/connect-identified')
    def connect_identified(body:IdentifiedConnect,req:Request):
        family=user(req,'guardian');throttle(('code',family['id']))
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            invite=identified_invite(c,body)
            c.execute('INSERT OR IGNORE INTO links VALUES(?,?)',(invite['owner_id'],family['id']))
            c.execute('DELETE FROM invites WHERE code_hash=?',(invite['code_hash'],))
        return {'ok':True}
    @app.get('/api/family/members')
    def members(req:Request):
        who=user(req)
        with db() as c:
            if who['role']=='guardian':
                rows=c.execute('SELECT u.id,u.display_name FROM users u JOIN links l ON u.id=l.owner_id WHERE l.family_id=?',(who['id'],)).fetchall()
            else:
                rows=c.execute('SELECT u.id,u.display_name FROM users u JOIN links l ON u.id=l.family_id WHERE l.owner_id=?',(who['id'],)).fetchall()
        return [{'id':r['id'],'displayName':r['display_name']} for r in rows]
    @app.delete('/api/family/members/{member_id}')
    def unlink(member_id:str,req:Request):
        who=user(req)
        with db() as c:
            if who['role']=='user':c.execute('DELETE FROM links WHERE owner_id=? AND family_id=?',(who['id'],member_id))
            else:c.execute('DELETE FROM links WHERE owner_id=? AND family_id=?',(member_id,who['id']))
        return {'ok':True}
    @app.post('/api/watch')
    def start_watch(body:StartWatch,req:Request):
        who=user(req,'user');v=by_id.get(body.videoId)
        s=next((s for s in v['segments'] if s['id']==body.segmentId),None) if v else None
        if not v or not s:raise HTTPException(404,'영상을 찾을 수 없어요.')
        plan=[{**q,'displayQuestion':CLOSING_INVITATIONS[q['id']]} if q['id'] in CLOSING_INVITATIONS else q
              for q in select_prompts(v,s)]
        wid=secrets.token_hex(16)
        with db() as c:c.execute('INSERT INTO watches VALUES(?,?,?,?,?,?,?,NULL)',(wid,who['id'],v['id'],s['id'],json.dumps(plan,ensure_ascii=False),time.time(),'ready'))
        return {'id':wid,'contentId':v['id'],'title':v['title'],'youtubeId':v['youtubeId'],'segment':s,'prompts':[public_prompt(q,s) for q in plan]}
    def explain_saved(watch_id, who):
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute("SELECT owner_id,report FROM watches WHERE id=? AND status='complete'", (watch_id,)).fetchone()
            if row is None or not allowed(c,who,row['owner_id']):raise HTTPException(404,'기록을 찾을 수 없어요.')
            payload=json.loads(row['report'])
            if payload['report'].get('interpretation') is not None:return payload['report']
            claim=c.execute('INSERT OR IGNORE INTO report_explanation_jobs VALUES(?,?)',(watch_id,'running'))
            if not claim.rowcount:return payload['report']  # never replay an uncertain request
        result=ReportResponse.model_validate(payload['report'])
        try: result.interpretation=generate_portal_explanation(result)
        except Exception as exc: result.interpretation=factual_explanation(result,type(exc).__name__)
        payload['report']=result.model_dump()
        with db() as c:
            c.execute('UPDATE watches SET report=? WHERE id=?',(json.dumps(payload,ensure_ascii=False),watch_id))
            c.execute('UPDATE report_explanation_jobs SET status=? WHERE watch_id=?',('complete',watch_id))
        return payload['report']

    @app.post('/api/family/report/{watch_id}/explanation')
    def explain_existing(watch_id:str,req:Request):
        return explain_saved(watch_id,user(req))

    @app.post('/api/report')
    def report(req:Request,watchId:str=Form(...),answers:str=Form(...),audio:list[UploadFile]=File(default=[]),nextMeeting:str=Form('')):
        who=user(req,'user')
        if nextMeeting not in NEXT_MEETINGS:raise HTTPException(422,'다음 만남 선택을 확인해 주세요.')
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            watch=c.execute('SELECT * FROM watches WHERE id=? AND owner_id=?',(watchId,who['id'])).fetchone()
            if not watch:raise HTTPException(404,'시청 기록을 찾을 수 없어요.')
            if watch['status']=='complete':return json.loads(watch['report'])['report']
            if watch['status']!='ready':raise HTTPException(409,'이미 기록을 정리하고 있어요. 다시 전송하지 않고 잠시 기다려 주세요.')
            try:incoming=json.loads(answers)
            except ValueError:raise HTTPException(422,'대화 형식을 확인해 주세요.')
            plan=json.loads(watch['plan']);pmap={q['id']:q for q in plan}
            if not isinstance(incoming,list) or not all(isinstance(i,dict) for i in incoming):raise HTTPException(422,'대화 형식을 확인해 주세요.')
            ids=[i.get('id') for i in incoming]
            if len(ids)>4 or not all(isinstance(i,str) for i in ids) or len(set(ids))!=len(ids) or any(i not in pmap for i in ids):raise HTTPException(422,'이번 시청에 연결된 대화만 저장할 수 있어요.')
            if len(audio)>4:raise HTTPException(422,'녹음 파일 수를 확인해 주세요.')
            filenames=[f.filename for f in audio]
            if len(set(filenames))!=len(filenames) or any(n not in {q+'.wav' for q in ids} for n in filenames):raise HTTPException(422,'녹음과 대화의 연결을 확인해 주세요.')
            items=[]
            for i in incoming:
                q=pmap[i['id']]
                items.append({'id':q['id'],'question':public_prompt(q,by_id[watch['video_id']]['segments'][0])['question'],
                              'correctAnswer':'','answerKeywords':[],'userAnswer':i.get('userAnswer','') if isinstance(i.get('userAnswer',''),str) else '',
                              'transcriptSource':'recorded','audioFilename':q['id']+'.wav' if q['id']+'.wav' in filenames else None,
                              'videoTimestamp':i.get('videoTimestamp',q['timestamp'] or 0) if isinstance(i.get('videoTimestamp',q['timestamp'] or 0),(int,float)) else 0})
            c.execute('UPDATE watches SET status=? WHERE id=?',('processing',watchId))
        session_dir=root/'recordings'/watchId;session_dir.mkdir(parents=True,exist_ok=True)
        try:
            result=backend._make_report(json.dumps(items,ensure_ascii=False),who['display_name'],None,audio,watch['video_id'],temp_dir=session_dir,recording_base_url=f'/api/score/report/audio/{watchId}',transcribe_missing=False,generate_interpretation=False)
        except Exception:
            from src.api.recording_store import bind_recordings
            items,_=bind_recordings(items,session_dir)
            result=backend._unavailable_report(who['display_name'],None,items,'분석을 마치지 못했어요. 저장한 대화와 녹음은 보존했어요.',recording_base_url=f'/api/score/report/audio/{watchId}')
        # Source answers are not independently checked. Preserve observations,
        # never turn unvalidated references or conversation into correctness.
        for factor in result.contentScore.factors:
            if factor.label in {'기억 정확도','문맥 일치도','시간·장소 지남력'}:
                factor.available=False;factor.score=0;factor.validated=False;factor.detail={'reason':'reference_not_validated_for_catalog'}
        result.analysisMode='partial'
        result.interpretation=None  # generate from the final visible axes after saving
        result.trend=[]
        result.notice=(result.notice+' ' if result.notice else '')+'영상 정답과 임상 기준이 검증되지 않은 항목은 점수를 제공하지 않아요.'
        payload={'id':watchId,'createdAt':watch['created'],'contentId':watch['video_id'],'title':by_id[watch['video_id']]['title'],
                 'selectedIds':list(pmap),'nextMeeting':nextMeeting,'report':result.model_dump()}
        with db() as c:c.execute('UPDATE watches SET status=?,report=? WHERE id=?',('complete',json.dumps(payload,ensure_ascii=False),watchId))
        return explain_saved(watchId,who)
    @app.get('/api/family/reports/{owner_id}')
    def reports(owner_id:str,req:Request):
        who=user(req)
        with db() as c:
            if not allowed(c,who,owner_id):raise HTTPException(403,'연결된 가족의 기록만 볼 수 있어요.')
            rows=c.execute("SELECT report FROM watches WHERE owner_id=? AND status='complete' ORDER BY created DESC LIMIT 20",(owner_id,)).fetchall()
        return [json.loads(r['report']) for r in rows]
    @app.get('/api/report/audio/{watch_id}/{filename}')
    def recording(watch_id:str,filename:str,req:Request):
        who=user(req)
        with db() as c:
            watch=c.execute('SELECT * FROM watches WHERE id=?',(watch_id,)).fetchone()
            if not watch or not allowed(c,who,watch['owner_id']):raise HTTPException(404,'녹음을 찾을 수 없어요.')
        path=root/'recordings'/watch_id/filename
        from src.api.recording_store import read_recordings
        original_names={q['id']+'.wav' for q in json.loads(watch['plan'])}
        valid={r.get('stored_filename') for r in read_recordings(path.parent)
               if r.get('complete') is True and r.get('original_filename') in original_names}
        if filename not in valid or not path.is_file() or path.is_symlink():raise HTTPException(404,'녹음을 찾을 수 없어요.')
        return FileResponse(path,media_type='audio/wav')
    # Reuse provider adapters, with authenticated calls; no anonymous legacy routes.
    @app.post('/api/tts')
    def tts(req:Request,body:TTSRequest):user(req,'user');return backend.synthesize_tts(body)
    @app.post('/api/respond')
    def respond(req:Request,body:EmpathyRequest):user(req,'user');return backend.generate_empathy(body)
    @app.post('/api/transcribe')
    def transcribe(req:Request,audio:UploadFile=File(...),answerKeywords:str=Form('[]')):
        user(req,'user');return backend.transcribe_answer(audio,answerKeywords)
    from src.api.welcome import install_welcome_routes
    install_welcome_routes(app, backend, root, db, user, allowed,
                           lambda req: digest(request_token(req)),
                           memory_provider=lambda owner,day,zone: memory_prompts(db,owner,day,zone))
    install_memory_routes(app,db,user)
    from src.api.live_stt import install_live_stt
    install_live_stt(app, db, extension_origins)
    # New flow transcribes once from its recording; it does not start a second STT stream.
    return app
