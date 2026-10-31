"""Synthetic account/ownership/selection contracts. No provider calls or clinical data."""
import hashlib
import json
import random
import sqlite3
import time
from types import SimpleNamespace
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api.portal import create_portal, select_prompts, public_prompt, CATALOG_PATH, HELD_IDS
from src.api.schema import ReportResponse, ScoreCategory, ScoreFactor, ReportQuestion

CATALOG=json.loads(CATALOG_PATH.read_text())
VIDEOS=[v for v in CATALOG['videos'] if v['youtubeId']]
ORIGIN={'Origin':'http://127.0.0.1:5173'}

def fake_report(answers,name,birth,audio,contentId,**kwargs):
    items=json.loads(answers)
    assert kwargs['transcribe_missing'] is False
    assert kwargs['generate_interpretation'] is False
    assert all(i['correctAnswer']=='' and i['answerKeywords']==[] for i in items)
    from src.api.recording_store import save_recordings, bind_recordings
    save_recordings(audio,kwargs['temp_dir'])
    items,_=bind_recordings(items,kwargs['temp_dir'])
    return ReportResponse(patientName=name,patientBirthDate=None,
      speechScore=ScoreCategory(key='speech',name='발화',description='작성 시험',factors=[ScoreFactor(label='침묵 시간',score=0,available=False)]),
      contentScore=ScoreCategory(key='content',name='내용',description='작성 시험',factors=[ScoreFactor(label='기억 정확도',score=99,available=True)]),
      questions=[ReportQuestion(id=i['id'],rank=n+1,impact=0,question=i['question'],correctAnswer=i['correctAnswer'],userAnswer=i['userAnswer'],videoTimestamp=i['videoTimestamp'],recordingUrl=kwargs['recording_base_url']+'/'+i['audioFilename'] if i.get('audioFilename') else None) for n,i in enumerate(items)],
      trend=[],interpretation=None,analysisMode='partial',notice='작성 시험',referenceMode='personal_baseline',referenceNotice='작성 시험')

@pytest.fixture
def setup(tmp_path):
    calls=[]
    def report(*args,**kwargs):calls.append(1);return fake_report(*args,**kwargs)
    def forbidden(*args,**kwargs):raise AssertionError('Unexpected provider call')
    backend=SimpleNamespace(_health=lambda:{'ok':True},_make_report=report,_unavailable_report=forbidden,synthesize_tts=forbidden,generate_empathy=forbidden,transcribe_answer=forbidden)
    app=create_portal(backend,tmp_path)
    return app,calls

def client(app):return TestClient(app,headers=ORIGIN)
def register(c,username,role='user',name='가상 사용자'):
    r=c.post('/api/account/register',json={'username':username,'displayName':name,'password':'fictional-password-123','role':role})
    assert r.status_code==200,r.text
    return r.json()
def start(c,video='lnvaFy7cRmk',segment='s1'):
    r=c.post('/api/watch',json={'videoId':video,'segmentId':segment});assert r.status_code==200,r.text;return r.json()
def submit(c,plan,text='작성한 가상 답변'):
    q=plan['prompts'][0]
    return c.post('/api/report',data={'watchId':plan['id'],'answers':json.dumps([{'id':q['id'],'userAnswer':text}])},files={'audio':(q['id']+'.wav',b'authored-fixture','audio/wav')})

def test_login_password_logout_and_cookie(setup):
    app,_=setup;c=client(app);who=register(c,'owner')
    assert c.get('/api/account/me').json()['id']==who['id']
    with sqlite3.connect(app.state.db_path) as db:
        salt,hashed=db.execute('SELECT salt,password_hash FROM users').fetchone()
        assert hashed!='fictional-password-123' and len(salt)==32
    assert c.post('/api/account/logout').status_code==200
    assert c.get('/api/account/me').status_code==401
    assert c.post('/api/account/login',json={'username':'owner','password':'wrong'}).status_code==401
    r=c.post('/api/account/login',json={'username':'OWNER','password':'fictional-password-123'})
    assert r.status_code==200
    cookie=r.headers['set-cookie'].lower();assert 'httponly' in cookie and 'samesite=strict' in cookie

@pytest.mark.parametrize('origin', [
    'http://127.0.0.1:5173', 'http://localhost:5173', 'http://192.168.0.178:5173',
])
@pytest.mark.parametrize('role', ['user', 'guardian'])
def test_login_from_local_and_team_lan_origins(setup, origin, role):
    app, calls = setup
    c = TestClient(app, base_url=origin, headers={'Origin': origin})
    account = register(c, 'synthetic-' + role, role)
    credentials = {'username': 'synthetic-' + role, 'password': 'fictional-password-123'}
    assert c.post('/api/account/logout').status_code == 200
    assert c.get('/api/account/me').status_code == 401
    assert c.post('/api/account/login', json={**credentials, 'password': 'wrong'}).status_code == 401
    result = c.post('/api/account/login', json=credentials)
    assert result.status_code == 200, result.text
    assert c.get('/api/account/me').json()['id'] == account['id']
    assert c.get('/api/account/me').json()['role'] == role
    cookie = result.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'samesite=strict' in cookie
    for denied in ['http://192.168.0.178:5174', 'http://192.168.0.179:5173',
                   'http://192.168.0.178.example.org:5173', 'https://unrelated.example', 'null', '']:
        result = c.post('/api/account/login', headers={'Origin': denied}, json=credentials)
        assert result.status_code == 403, denied
    assert calls == []


def test_expired_login_and_cross_origin(setup):
    app,_=setup;c=client(app);register(c,'owner')
    assert c.post('/api/family/code',headers={'Origin':'https://unrelated.example'}).status_code==403
    with sqlite3.connect(app.state.db_path) as db:db.execute('UPDATE sessions SET expires=0')
    assert c.get('/api/account/me').status_code==401

def test_family_link_ownership_and_revoke(setup):
    app,calls=setup;owner=client(app);who=register(owner,'owner')
    family=client(app);register(family,'family','guardian')
    outsider=client(app);register(outsider,'other','guardian')
    assert family.get('/api/family/reports/'+who['id']).status_code==403
    code=owner.post('/api/family/code').json()['code']
    assert family.post('/api/family/connect',json={'code':code}).status_code==200
    assert outsider.post('/api/family/connect',json={'code':code}).status_code==400
    assert family.get('/api/family/members').json()==[{'id':who['id'],'displayName':'가상 사용자'}]
    assert family.get('/api/family/reports/'+who['id']).json()==[]  # never mock
    plan=start(owner);saved=submit(owner,plan);assert saved.status_code==200,saved.text
    assert len(calls)==1
    rows=family.get('/api/family/reports/'+who['id']).json();assert len(rows)==1
    assert rows[0]['selectedIds']==[p['id'] for p in plan['prompts']]
    assert rows[0]['report']['contentScore']['factors'][0]['available'] is False
    assert rows[0]['report']['contentScore']['factors'][0]['score']==0
    assert rows[0]['report']['notice'].startswith('작성 시험 ')
    path=rows[0]['report']['questions'][0]['recordingUrl'].replace('/api/score/','/api/')
    assert family.get(path).status_code==200
    assert outsider.get(path).status_code==404
    assert outsider.get('/api/family/reports/'+who['id']).status_code==403
    family_id=family.get('/api/account/me').json()['id']
    owner.delete('/api/family/members/'+family_id)
    assert family.get('/api/family/reports/'+who['id']).status_code==403
    assert family.get(path).status_code==404

def test_invite_expiry_reissue_and_roles(setup):
    app,_=setup;o=client(app);register(o,'owner');f=client(app);register(f,'family','guardian')
    assert f.post('/api/family/code').status_code==403
    assert f.post('/api/watch',json={'videoId':'lnvaFy7cRmk','segmentId':'s1'}).status_code==403
    old=o.post('/api/family/code').json()['code'];new=o.post('/api/family/code').json()['code']
    assert f.post('/api/family/connect',json={'code':old}).status_code==400
    with sqlite3.connect(app.state.db_path) as db:db.execute('UPDATE invites SET expires=0')
    assert f.post('/api/family/connect',json={'code':new}).status_code==400

def test_report_idempotency_and_cross_account_submission(setup):
    app,calls=setup;a=client(app);register(a,'one');b=client(app);register(b,'two')
    plan=start(a)
    assert submit(b,plan).status_code==404
    first=submit(a,plan);second=submit(a,plan)
    assert first.status_code==second.status_code==200
    assert first.json()==second.json() and len(calls)==1

def test_request_validation_no_provider_call(setup):
    app,calls=setup;c=client(app);register(c,'owner');plan=start(c);q=plan['prompts'][0]
    for rows in [[{'id':'forged'}],[{'id':[]}],[{'id':q['id']},{'id':q['id']}],{},'bad']:
        assert c.post('/api/report',data={'watchId':plan['id'],'answers':json.dumps(rows)}).status_code==422
    assert c.post('/api/report',data={'watchId':plan['id'],'answers':json.dumps([{'id':q['id']}])},files={'audio':('../foreign.wav',b'fixture','audio/wav')}).status_code==422
    assert not calls
    assert client(app).post('/api/report',data={'watchId':plan['id'],'answers':'[]'}).status_code==401
    assert c.get('/api/report/latest?patientName=other').status_code==404
    assert c.get('/api/report/mock').status_code==404

def test_no_name_based_link_or_history(setup):
    app,_=setup;a=client(app);who=register(a,'one',name='같은 이름');b=client(app);register(b,'two',name='같은 이름')
    assert b.get('/api/family/reports/'+who['id']).status_code==403

@pytest.mark.parametrize('identity',['viewer_id','VIEWER_ID','가상 가족',' 가상 가족 '])
def test_family_registration_links_consented_viewer_not_own_display_name(setup,identity):
    app,_=setup;o=client(app);who=register(o,'viewer_id',name='가상 가족')
    code=o.post('/api/family/code').json()['code'];f=client(app)
    r=f.post('/api/account/register-family',json={'username':'family_own_id','password':'fictional-password-123','memberIdentity':identity,'code':code})
    assert r.status_code==200,r.text
    assert r.json()['role']=='guardian' and r.json()['displayName']=='family_own_id'
    assert f.get('/api/family/members').json()==[{'id':who['id'],'displayName':'가상 가족'}]
    assert f.get('/api/family/reports/'+who['id']).status_code==200
    assert client(app).post('/api/account/register-family',json={'username':'other_family','password':'fictional-password-123','memberIdentity':identity,'code':code}).status_code==400

@pytest.mark.parametrize('kind',['wrong_identity','wrong_code','expired','blank_identity','missing_code'])
def test_family_registration_failure_is_atomic(setup,kind):
    app,_=setup;o=client(app);register(o,'viewer',name='가상 가족');f=client(app)
    code=o.post('/api/family/code').json()['code']
    body={'username':'family_new','password':'fictional-password-123','memberIdentity':'viewer','code':code}
    if kind=='wrong_identity':body['memberIdentity']='다른 사람'
    if kind=='wrong_code':body['code']='INVALID_CODE'
    if kind=='expired':
        with sqlite3.connect(app.state.db_path) as db:db.execute('UPDATE invites SET expires=0')
    if kind=='blank_identity':body['memberIdentity']='   '
    if kind=='missing_code':body.pop('code')
    r=f.post('/api/account/register-family',json=body)
    assert r.status_code==(422 if kind=='missing_code' else 400)
    assert f.get('/api/account/me').status_code==401
    with sqlite3.connect(app.state.db_path) as db:
        assert db.execute('SELECT count(*) FROM users').fetchone()[0]==1
        assert db.execute('SELECT count(*) FROM links').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM invites').fetchone()[0]==1

def test_family_existing_account_id_keeps_invite_and_own_session(setup):
    app,_=setup;o=client(app);register(o,'viewer');f=client(app);register(f,'family_existing','guardian')
    code=o.post('/api/family/code').json()['code']
    r=f.post('/api/account/register-family',json={'username':'family_existing','password':'fictional-password-123','memberIdentity':'viewer','code':code})
    assert r.status_code==409
    assert f.get('/api/family/members').json()==[]
    assert f.post('/api/family/connect-identified',json={'code':code,'memberIdentity':'viewer'}).status_code==200

def test_duplicate_names_resolve_only_with_specific_invite(setup):
    app,_=setup;a=client(app);one=register(a,'viewer_a',name='같은 이름');b=client(app);two=register(b,'viewer_b',name='같은 이름')
    code=b.post('/api/family/code').json()['code'];f=client(app);register(f,'family','guardian')
    assert f.post('/api/family/connect-identified',json={'code':code,'memberIdentity':'viewer_a'}).status_code==400
    assert f.post('/api/family/connect-identified',json={'code':code,'memberIdentity':'같은 이름'}).status_code==200
    assert f.get('/api/family/reports/'+one['id']).status_code==403
    assert f.get('/api/family/reports/'+two['id']).status_code==200

def test_identified_connection_role_and_origin_checks(setup):
    app,_=setup;o=client(app);register(o,'viewer');code=o.post('/api/family/code').json()['code']
    assert o.post('/api/family/connect-identified',json={'code':code,'memberIdentity':'viewer'}).status_code==403
    stranger=client(app)
    assert stranger.post('/api/family/connect-identified',json={'code':code,'memberIdentity':'viewer'}).status_code==401
    r=stranger.post('/api/account/register-family',headers={'Origin':'https://unrelated.example'},json={'username':'family','password':'fictional-password-123','memberIdentity':'viewer','code':code})
    assert r.status_code==403

@pytest.mark.parametrize('video',VIDEOS,ids=lambda v:v['id'])
def test_sampling_caps_stability_spacing_and_source_provenance(video):
    for segment in video['segments']:
        for seed in range(40):
            result=select_prompts(video,segment,random.Random(seed))
            assert 0<len(result)<=4
            assert len({q['id'] for q in result})==len(result)
            assert not (HELD_IDS&{q['id'] for q in result})
            assert all(q['segmentId']==segment['id'] and q in video['questions'] for q in result)
            times=[q['timestamp'] for q in result if q['delivery']=='at_time' and q['timestamp']]
            assert times==sorted(times)
            assert all(b-a>=20 for a,b in zip(times,times[1:]))
            assert result==select_prompts(video,segment,random.Random(seed))
            for q in result:
                public=public_prompt(q,segment)
                assert not {'answer','rubric','referenceStatus','automaticScoring'}&public.keys()
                if q['timestamp']==0:assert public['delivery']=='after_video'

def test_randomization_not_fixed_first_four():
    video=next(v for v in VIDEOS if v['id']=='XVG3-rpW7bQ');segment=video['segments'][0]
    assert len({tuple(q['id'] for q in select_prompts(video,segment,random.Random(s))) for s in range(30)})>10

@pytest.mark.parametrize('video',VIDEOS,ids=lambda v:v['id'])
def test_all_110_new_prompts_do_not_claim_automatic_correctness(video):
    from src.api.server import _score_question_answers
    for q in video['questions']:
        for answer in (q['answer'] or '작성한 감상', '작성한 다른 답', ''):
            score=_score_question_answers([{'id':q['id'],'question':q['question'],'userAnswer':answer,'correctAnswer':'','answerKeywords':[]}],use_llm=False)
            assert score['기억 정확도']['score'] is None
            assert score['문맥 일치도']['score'] is None
