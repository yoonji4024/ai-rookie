"""Session provenance: future copy edits must not rewrite a delivered question."""
import json
import sqlite3
import pytest
from test_extension_access import env
from src.api import portal

@pytest.mark.parametrize('via_extension',[True,False])
@pytest.mark.parametrize('video,qid', [('q-2EmyuAOmM','q-2EmyuAOmM-q9'),('mt7CuNcNXvk','mt7CuNcNXvk-q10')])
def test_delivered_copy_survives_later_revision_and_report_save(env,monkeypatch,via_extension,video,qid):
    app,owner,who,ext,_,_=env
    client=ext if via_extension else owner
    before=portal.CATALOG_PATH.read_bytes()
    response=client.post('/api/watch',json={'videoId':video,'segmentId':'full'})
    assert response.status_code==200
    watch=response.json()
    delivered=next(q['question'] for q in watch['prompts'] if q['id']==qid)
    assert delivered.startswith('저는 ') and '생각나는 대로' in delivered
    with sqlite3.connect(app.state.db_path) as db:
        frozen=json.loads(db.execute('SELECT plan FROM watches WHERE id=?',(watch['id'],)).fetchone()[0])
    q=next(q for q in frozen if q['id']==qid)
    assert '순서대로' in q['question'] and q['displayQuestion']==delivered
    # Simulate a subsequent copy revision before this session is submitted.
    monkeypatch.setitem(portal.CLOSING_INVITATIONS,qid,'다른 표시 문구')
    result=client.post('/api/report',data={'watchId':watch['id'],'answers':json.dumps([{'id':qid,'userAnswer':''}])})
    assert result.status_code==200
    saved=owner.get('/api/family/reports/'+who['id']).json()[0]
    assert next(q['question'] for q in saved['report']['questions'] if q['id']==qid)==delivered
    legacy={k:v for k,v in q.items() if k!='displayQuestion'}
    assert '순서대로' in portal.public_prompt(legacy,{'end':155})['question']
    assert portal.CATALOG_PATH.read_bytes()==before
