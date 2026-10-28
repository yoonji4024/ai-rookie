"""New authored recordings and assertions; historical tests remain unchanged."""
import io
import json
import sqlite3
import wave
from datetime import date,timedelta
import pytest
from fastapi.testclient import TestClient
from test_extension_access import env,WEB,ORIGIN,PASSWORD
from src.api import portal
from src.api.schema import Interpretation,ReportResponse,ScoreCategory,ScoreFactor
from src.api import portal_explanation as explanation

@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    import requests
    def forbidden(*a,**k):raise AssertionError('Unexpected provider request')
    monkeypatch.setattr(requests.sessions.Session,'request',forbidden)

def wav():
    buf=io.BytesIO()
    with wave.open(buf,'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\1\0'*16000)
    return buf.getvalue()

def welcome(ext):
    return ext.post('/api/welcome/start',json={'timezone':'Asia/Seoul'}).json()

def relog(ext):
    ext.post('/api/account/logout');ext.headers.pop('Authorization',None)
    r=ext.post('/api/extension/login',json={'username':'owner','password':PASSWORD})
    ext.headers['Authorization']='Bearer '+r.json()['token']

def smalltalk(ext,text='오늘은 친구와 시장에 갈 예정이에요.'):
    plan=welcome(ext)
    rows=[{'id':'s-daily-plan','userAnswer':text,'state':'recorded'}]
    r=ext.post('/api/welcome/finish',data={'welcomeId':plan['id'],'answers':json.dumps(rows)},files={'audio':('s-daily-plan.wav',wav(),'audio/wav')})
    assert r.status_code==200,r.text
    return plan

def watch(ext,next_meeting=''):
    video=ext.get('/api/extension/catalog').json()[0]
    p=ext.post('/api/watch',json={'videoId':video['id'],'segmentId':video['segments'][0]['id']}).json()
    r=ext.post('/api/report',data={'watchId':p['id'],'answers':'[]','nextMeeting':next_meeting})
    assert r.status_code==200,r.text
    return p,r.json()

@pytest.mark.skip(reason="Historical date-first welcome order; current smalltalk-first order is covered by test_dialogue_routes")
def test_first_login_has_smalltalk_without_invented_memory(env):
    _,_,_,ext,_,_=env
    plan=welcome(ext)
    assert [p['id'] for p in plan['prompts']]==['o-date-weekday','o-place','s-daily-plan']
    assert ext.get('/api/memory').json()=={'previous':None,'promise':None}
    assert ext.get('/api/welcome').json()==plan

def test_followup_uses_real_saved_smalltalk_next_login_and_stays_out_of_scoring(env):
    app,owner,who,ext,_,_=env
    smalltalk(ext);relog(ext)
    plan=welcome(ext)
    assert plan['prompts'][0]['id']=='m-previous-dialogue'
    assert '친구와 시장' in plan['prompts'][0]['question']
    assert plan['prompts'][0]['question'].startswith('조금 전')
    rows=owner.get('/api/family/welcomes/'+who['id']).json()
    assert all(i['id'].startswith('o-') for i in rows[0]['observations']['questions'])
    assert any(i['id']=='s-daily-plan' and i['state']=='recorded' for i in rows[0]['items'])

def test_yesterday_only_for_matching_dates_and_timezone(env):
    app,_,_,ext,_,_=env
    first=smalltalk(ext)
    with sqlite3.connect(app.state.db_path) as c:
        raw=c.execute('SELECT record FROM welcomes WHERE id=?',(first['id'],)).fetchone()[0]
        record=json.loads(raw);record['reference']['date']=(date.today()-timedelta(days=1)).isoformat()
        c.execute('UPDATE welcomes SET record=? WHERE id=?',(json.dumps(record),first['id']))
    relog(ext);plan=welcome(ext)
    assert plan['prompts'][0]['question'].startswith('어제')
    # Once started, a plan is frozen despite source record changes.
    with sqlite3.connect(app.state.db_path) as c:c.execute('UPDATE welcomes SET record=NULL WHERE id=?',(first['id'],))
    assert ext.get('/api/welcome').json()['prompts']==plan['prompts']

def test_forget_removes_ready_followup_and_preserves_family_report(env):
    app,owner,who,ext,_,_=env
    smalltalk(ext);p,_=watch(ext,'tomorrow');relog(ext);welcome(ext)
    assert ext.post('/api/memory/clear',json={}).status_code==200
    assert ext.get('/api/memory').json()=={'previous':None,'promise':None}
    assert ext.get('/api/welcome').json()=={'state':'needed'}
    assert len(owner.get('/api/family/reports/'+who['id']).json())==1

def test_promises_only_from_explicit_choice_and_owner_isolation(env):
    app,_,_,ext,_,_=env
    watch(ext,'tomorrow')
    assert ext.get('/api/memory').json()['promise']['text']=='내일 다시 함께 보기'
    other=TestClient(app,headers=WEB)
    other.post('/api/account/register',json={'username':'unrelated','password':PASSWORD,'role':'user'})
    assert other.get('/api/memory').json()=={'previous':None,'promise':None}
    family=TestClient(app,headers=WEB)
    family.post('/api/account/register',json={'username':'guardian','password':PASSWORD,'role':'guardian'})
    assert family.get('/api/memory').status_code==403
    relog(ext);p=welcome(ext)
    assert any(x['id']=='m-next-meeting' for x in p['prompts'])

def test_unconfirmed_or_silent_smalltalk_is_not_remembered(env):
    _,_,_,ext,_,_=env
    p=welcome(ext)
    r=ext.post('/api/welcome/finish',data={'welcomeId':p['id'],'answers':json.dumps([{'id':'s-daily-plan','state':'untranscribed','userAnswer':''}])},files={'audio':('s-daily-plan.wav',wav(),'audio/wav')})
    assert r.status_code==200
    assert ext.get('/api/memory').json()['previous'] is None

def test_latest_no_promise_choice_does_not_resurrect_older_promise(env):
    _,_,_,ext,_,_=env
    watch(ext,'tomorrow')
    watch(ext,'')
    assert ext.get('/api/memory').json()['promise'] is None

def test_explanation_is_filtered_stored_and_idempotent(env,monkeypatch):
    _,owner,who,ext,_,_=env
    calls=[]
    def generate(report):
        calls.append(explanation.measured_input(report))
        return Interpretation(summary='작성 검증 설명',verified=True)
    monkeypatch.setattr(portal,'generate_portal_explanation',generate)
    p,r=watch(ext)
    assert calls==[{'axes':{}}]  # unvalidated memory accuracy never reaches generator
    assert r['interpretation']['summary']=='작성 검증 설명'
    again=owner.post('/api/family/report/'+p['id']+'/explanation',json={})
    assert again.status_code==200 and len(calls)==1
    assert owner.get('/api/family/reports/'+who['id']).json()[0]['report']==r
    assert ext.post('/api/family/report/'+p['id']+'/explanation',json={}).status_code==403

def test_old_report_explanation_requires_family_link_and_no_retry_of_running_job(env,monkeypatch):
    app,owner,who,ext,_,_=env
    p,_=watch(ext)
    with sqlite3.connect(app.state.db_path) as c:
        payload=json.loads(c.execute('SELECT report FROM watches WHERE id=?',(p['id'],)).fetchone()[0]);payload['report']['interpretation']=None
        c.execute('UPDATE watches SET report=? WHERE id=?',(json.dumps(payload),p['id']))
        c.execute("UPDATE report_explanation_jobs SET status='running' WHERE watch_id=?",(p['id'],))
    def forbidden(*a):raise AssertionError('Do not resubmit an uncertain request')
    monkeypatch.setattr(portal,'generate_portal_explanation',forbidden)
    family=TestClient(app,headers=WEB)
    family.post('/api/account/register',json={'username':'family-new','password':PASSWORD,'role':'guardian'})
    url='/api/family/report/'+p['id']+'/explanation'
    assert family.post(url,json={}).status_code==404
    code=owner.post('/api/family/code').json()['code'];family.post('/api/family/connect',json={'code':code})
    assert family.post(url,json={}).json()['interpretation'] is None

def sample():
    return ReportResponse(speechScore=ScoreCategory(key='speech',name='발화',description='',factors=[ScoreFactor(label='침묵 시간',score=61)]),
                          contentScore=ScoreCategory(key='content',name='내용',description='',factors=[ScoreFactor(label='기억 정확도',score=0,available=False)]))

@pytest.mark.parametrize('failure',['format','extra_axis','verifier','exception'])
def test_bad_generated_explanations_are_not_displayed(monkeypatch,failure):
    from src.common import llm
    from src.agents.analysis.scoring import verify_agent
    obj={'summary':'작성 요약','axis_comments':{'침묵 시간':'침묵 시간은 61점입니다. (observed-axis-0)'},'caveats':'녹음 환경을 확인해 주세요.','recommendation':'실제 응답을 확인해 주세요.'}
    if failure=='extra_axis':obj['axis_comments']['기억 정확도']='기억이 좋아요.'
    def chat(*a,**k):
        if failure=='exception':raise TimeoutError()
        return 'bad' if failure=='format' else json.dumps(obj)
    monkeypatch.setattr(llm,'chat',chat)
    monkeypatch.setattr(verify_agent,'verify_report',lambda *a,**k:{'pass':False})
    result=explanation.generate_portal_explanation(sample())
    assert result.verified is False
    assert '기억 정확도' not in result.axisComments
    assert result.summary!='작성 요약'

def test_valid_generator_uses_current_visible_scores_only(monkeypatch):
    from src.common import llm
    from src.agents.analysis.scoring import verify_agent
    seen=[]
    def chat(model,system,user,**kwargs):
        seen.append(user)
        return json.dumps({'summary':'이번 발화 관찰값을 안내해요.','axis_comments':{'침묵 시간':'침묵 시간은 61점입니다. (observed-axis-0)'},'caveats':'녹음 환경을 확인해 주세요.','recommendation':'실제 응답을 확인해 주세요.'})
    monkeypatch.setattr(llm,'chat',chat)
    monkeypatch.setattr(verify_agent,'verify_report',lambda *a,**k:{'pass':True})
    result=explanation.generate_portal_explanation(sample())
    assert result.verified and len(seen)==1
    assert '기억 정확도' not in seen[0] and '61점' in seen[0]
