"""Authored accounts and fabricated responses only; provider calls forbidden."""
import hashlib
import json
import sqlite3
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from src.api.portal import create_portal,COOKIE
from src.api.server import _score_orientation_answers
from test_portal import fake_report

ORIGIN='chrome-extension://akoiangaganminhnneneodkjbeeemadm'
WEB={'Origin':'http://127.0.0.1:5173'}
PASSWORD='synthetic-password-123'
@pytest.fixture
def env(tmp_path):
    calls=[]
    def forbidden(*args,**kwargs):raise AssertionError('Provider calls forbidden')
    def report(*args,**kwargs):calls.append('report');return fake_report(*args,**kwargs)
    backend=SimpleNamespace(_health=lambda:{'ok':True},_make_report=report,_unavailable_report=forbidden,
       _score_orientation_answers=_score_orientation_answers,synthesize_tts=forbidden,generate_empathy=forbidden,transcribe_answer=forbidden)
    app=create_portal(backend,tmp_path,extension_origins=[ORIGIN])
    owner=TestClient(app,headers=WEB)
    who=owner.post('/api/account/register',json={'username':'owner','password':PASSWORD,'role':'user'}).json()
    ext=TestClient(app,headers={'Origin':ORIGIN})
    res=ext.post('/api/extension/login',json={'username':'owner','password':PASSWORD})
    assert res.status_code==200
    token=res.json()['token'];ext.headers['Authorization']='Bearer '+token
    return app,owner,who,ext,token,calls

def test_scoped_login_no_cookie_and_catalog(env):
    app,owner,who,ext,token,calls=env
    assert not ext.cookies
    assert ext.get('/api/account/me').json()['id']==who['id']
    catalog=ext.get('/api/extension/catalog').json()
    assert len(catalog)==11 and all(set(v)=={'id','title','segments'} for v in catalog)
    with sqlite3.connect(app.state.db_path) as db:
        stored=db.execute('SELECT token_hash FROM extension_sessions').fetchone()[0]
    assert stored==hashlib.sha256(token.encode()).hexdigest() and stored!=token
    assert calls==[]

@pytest.mark.parametrize('path,method',[('/api/family/members','GET'),('/api/family/code','POST'),('/api/family/reports/other','GET'),('/api/report/audio/x/y.wav','GET'),('/api/welcome/audio/x/y.wav','GET')])
def test_extension_cannot_read_family_or_recordings(env,path,method):
    app,owner,who,ext,token,calls=env
    assert ext.request(method,path).status_code==403
    assert calls==[]

@pytest.mark.parametrize('origin',['https://www.youtube.com','https://unrelated.example','chrome-extension://'+'a'*32])
def test_wrong_origin_and_preflight_fail(env,origin):
    app,owner,who,ext,token,calls=env
    bad=TestClient(app,headers={'Origin':origin,'Authorization':'Bearer '+token})
    assert bad.get('/api/account/me').status_code==401
    assert bad.post('/api/welcome/start',json={'timezone':'Asia/Seoul'}).status_code==403
    pre=bad.options('/api/extension/login',headers={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'})
    assert pre.status_code==400
    assert 'access-control-allow-origin' not in pre.headers

def test_extension_preflight_and_privileged_header(env):
    app,owner,who,ext,token,calls=env
    pre=ext.options('/api/extension/login',headers={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-memflix-extension'})
    assert pre.status_code==200 and pre.headers['access-control-allow-origin']==ORIGIN
    c=TestClient(app,headers={'X-Memflix-Extension':ORIGIN.rsplit('/',1)[1],'Authorization':'Bearer '+token})
    assert c.get('/api/account/me').status_code==200
    assert c.post('/api/welcome/start',json={'timezone':'Asia/Seoul'}).status_code==200

def test_web_cookie_and_extension_token_not_interchangeable(env):
    app,owner,who,ext,token,calls=env
    bad=TestClient(app,headers=WEB);bad.cookies.set(COOKIE,token)
    assert bad.get('/api/account/me').status_code==403
    ext.headers['Authorization']='Bearer '+owner.cookies[COOKIE]
    assert ext.get('/api/account/me').status_code==401
    ext.headers.pop('Authorization');ext.cookies.set(COOKIE,owner.cookies[COOKIE])
    assert ext.get('/api/account/me').status_code==401

def test_expiration_logout_and_web_session_survives(env):
    app,owner,who,ext,token,calls=env
    assert ext.post('/api/account/logout').status_code==200
    assert ext.get('/api/account/me').status_code==401
    assert owner.get('/api/account/me').status_code==200
    ext.headers.pop('Authorization')
    token=ext.post('/api/extension/login',json={'username':'owner','password':PASSWORD}).json()['token']
    ext.headers['Authorization']='Bearer '+token
    with sqlite3.connect(app.state.db_path) as db:db.execute('UPDATE sessions SET expires=0 WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),))
    assert ext.get('/api/account/me').status_code==401

def test_guardian_login_wrong_password_and_unconfigured_origin(env,tmp_path):
    app,owner,who,ext,token,calls=env
    family=TestClient(app,headers=WEB)
    family.post('/api/account/register',json={'username':'family','password':PASSWORD,'role':'guardian'})
    assert ext.post('/api/extension/login',json={'username':'family','password':PASSWORD}).status_code==403
    assert ext.post('/api/extension/login',json={'username':'owner','password':'wrong'}).status_code==401
    assert owner.post('/api/extension/login',json={'username':'owner','password':PASSWORD}).status_code==403
    plain=create_portal(SimpleNamespace(_health=lambda:{}),tmp_path/'plain')
    assert TestClient(plain,headers={'Origin':ORIGIN}).post('/api/extension/login',json={'username':'owner','password':PASSWORD}).status_code==403

def test_welcome_separate_web_session_and_idempotent_skip(env):
    app,owner,who,ext,token,calls=env
    p=ext.post('/api/welcome/start',json={'timezone':'Asia/Seoul'}).json()
    assert ext.get('/api/welcome').json()==p and 'reference' not in p
    assert owner.get('/api/welcome').json()=={'state':'needed'}
    assert owner.post('/api/welcome/finish',data={'welcomeId':p['id'],'answers':'[]'}).status_code==404
    for _ in range(2):assert ext.post('/api/welcome/finish',data={'welcomeId':p['id'],'answers':'[]'}).json()['state']=='skipped'
    assert calls==[]

def test_watch_to_authorized_family_only(env):
    app,owner,who,ext,token,calls=env
    video=next(v for v in ext.get('/api/extension/catalog').json() if v['id']=='a2GT6K5yzAY')
    p=ext.post('/api/watch',json={'videoId':video['id'],'segmentId':video['segments'][0]['id']}).json()
    assert 'id' in p,p
    assert 0<len(p['prompts'])<=4
    assert all('answer' not in q and 'correctAnswer' not in q for q in p['prompts'])
    q=p['prompts'][0]
    # No fabricated transcript; a missing recording stays unavailable.
    r=ext.post('/api/report',data={'watchId':p['id'],'answers':json.dumps([{'id':q['id'],'state':'skipped','userAnswer':''}])})
    assert r.status_code==200,r.text
    assert r.json()['contentScore']['factors'][0]['available'] is False
    assert ext.get('/api/extension/watch-state',params={'watchId':p['id']}).json()=={'state':'complete'}
    ext.post('/api/report',data={'watchId':p['id'],'answers':'[]'})
    assert calls==['report']
    family=TestClient(app,headers=WEB)
    family.post('/api/account/register',json={'username':'family','password':PASSWORD,'role':'guardian'})
    assert family.get('/api/family/reports/'+who['id']).status_code==403
    code=owner.post('/api/family/code').json()['code'];family.post('/api/family/connect',json={'code':code})
    assert len(family.get('/api/family/reports/'+who['id']).json())==1
    member=owner.get('/api/family/members').json()[0]['id'];owner.delete('/api/family/members/'+member)
    assert family.get('/api/family/reports/'+who['id']).status_code==403
