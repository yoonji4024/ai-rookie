import json
from types import SimpleNamespace

import pytest
import requests

from src.agents.analysis import cross_check
from src.agents.analysis.scoring import interpret, verify_agent
from src.common import llm


BAD='현재 점수로는 즉각적인 전문 상담이 필요하지 않으나 반복 관찰하세요.'


@pytest.mark.parametrize('report',[{'summary':BAD},{'axis_comments':{'발화':BAD}},
                                   {'recommendation':BAD},{'caveats':[BAD]}])
def test_both_verifiers_reject_before_network(monkeypatch,report):
    def forbidden(*a,**kw):pytest.fail('Rule rejection must bypass external API')
    monkeypatch.setattr(requests.sessions.Session,'request',forbidden)
    a=cross_check.check_report(report,{'total_score':60})
    b=verify_agent.verify_report(report,{'total_score':60},{})
    assert a['verdict']=='fail' and a['llm_called'] is False
    assert not b['pass'] and b['llm']['skipped']=='rule_failed'


@pytest.mark.parametrize('text',[
    '어려움이 지속되면 상담을 고려하세요.',
    '상담이 필요 없다고 단정할 수 없습니다.',
    '이 점수만으로 전문 상담이 불필요하다고 확정할 수 없습니다.',
])
def test_guard_does_not_replace_llm_for_allowed_advice(monkeypatch,text):
    calls=[]
    def verifier(*a,**kw):
        calls.append(a)
        return {'verdict':'pass','grounded':True,'no_diagnosis':True,'no_invention':True,'issues':[]}
    monkeypatch.setattr(cross_check,'chat_json',verifier)
    assert cross_check.check_report({'summary':text},{'total_score':60})['verdict']=='pass'
    assert len(calls)==1 and calls[0][0]=='solar'
    assert verify_agent.rule_checks({'summary':text},{'total_score':60},[],set())['pass']


def test_generated_unsafe_advice_falls_back_to_measured_facts(monkeypatch):
    monkeypatch.delenv('LLM_MOCK',raising=False)
    ev=SimpleNamespace(id='exp-guard',text='총점은 한 시점의 관찰값입니다.',
                       kind='exp',cite='',axes=(),tags=())
    monkeypatch.setattr(interpret,'retrieve_for_scores',lambda *a,**kw:{'발화':[ev]})
    calls=[]
    def generate(*a,**kw):calls.append(a);return json.dumps({'summary':BAD},ensure_ascii=False)
    monkeypatch.setattr(llm,'chat',generate)
    result=interpret.interpret_scores({'total_score':60,'axes':{}},max_retries=0)
    assert len(calls)==1 and calls[0][0]=='solar'
    assert result['mode']=='factual' and not result['verify']['pass']
    assert '60' in result['report']['summary'] and BAD not in json.dumps(result['report'],ensure_ascii=False)
