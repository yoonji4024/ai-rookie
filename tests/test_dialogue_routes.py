import json,random
from datetime import datetime
from zoneinfo import ZoneInfo
import pytest
from test_extension_access import env
from src.api import portal,welcome

@pytest.mark.parametrize('hour,future',[(9,True),(12,False),(18,False),(23,False)])
def test_new_greeting_uses_local_time_and_starts_with_smalltalk(env,monkeypatch,hour,future):
    _,_,_,ext,_,_=env
    stamp=datetime(2026,10,14,hour,tzinfo=ZoneInfo('Asia/Seoul')).timestamp()
    monkeypatch.setattr(welcome.time,'time',lambda:stamp)
    p=ext.post('/api/welcome/start',json={'timezone':'Asia/Seoul'}).json()
    assert [q['id'] for q in p['prompts']]==['s-daily-plan','o-date-weekday','o-place']
    assert ('예정' in p['prompts'][0]['question'])==future
    assert ext.get('/api/welcome').json()==p

def test_short_news_reserves_authored_free_recall_and_only_one_interruption():
    video=next(v for v in json.loads(portal.CATALOG_PATH.read_text())['videos'] if v['id']=='q-2EmyuAOmM')
    for seed in range(50):
        selected=portal.select_prompts(video,video['segments'][0],random.Random(seed))
        during=[q for q in selected if q['delivery']=='at_time' and q['timestamp']!=0]
        after=[q for q in selected if q['delivery']=='after_video' or q['timestamp']==0]
        assert len(during)<=1 and len(after)==1 and len(selected)<=2
        assert '순서' in after[0]['question']
        assert all(q in video['questions'] for q in selected)
