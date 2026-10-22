import pytest

from src.agents.analysis.scoring.report_contract import unsupported_reassurance_spans


@pytest.mark.parametrize('text',[
 '현재 점수로는 즉각적인 전문 상담이 필요하지 않으나 반복 관찰하세요.',
 '현재 점수로는 즉각적인 전문 상담이 필요하지 않습니다.',
 '검사가 필요 없습니다.', '진료는 불필요합니다.',
 '전문 상담은 더 이상 필요 없어요.',
])
def test_unlicensed_direct_reassurance_is_flagged(text):
    assert unsupported_reassurance_spans(text)


@pytest.mark.parametrize('text',[
 '어려움이 지속되면 상담을 고려하세요.',
 '점수만으로 상담의 필요성을 판단할 수 없습니다.',
 '이 점수만으로 전문 상담이 불필요하다고 확정할 수 없습니다.',
 '상담이 필요 없다고 단정할 수 없습니다.',
 '상담이 필요 없습니다라는 뜻이 아닙니다.',
 '지금 상담이 필요한지는 이 수치로 알 수 없습니다.',
 '평소와 같은 조건에서 반복 관찰해 보세요.',
])
def test_supported_conditional_advice_and_uncertainty_remain_available(text):
    assert not unsupported_reassurance_spans(text)
