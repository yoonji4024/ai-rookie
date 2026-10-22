"""Explain only the measurements actually released to the family portal.

No clinical corpus lookup, embeddings, transcript transmission or historical inference.
The existing numeric/claim/schema and entailment validators still apply.
"""
from src.api.schema import Interpretation


def measured_input(report):
    return {'axes': {
        f.label: {'score': f.score, 'available': True, 'features': {}}
        for category in (report.speechScore, report.contentScore)
        for f in category.factors if f.available
    }}


def factual_explanation(report, issue=''):
    from src.agents.analysis.scoring.verify_agent import AXIS_DEFINITIONS
    axes = measured_input(report)['axes']
    return Interpretation(
        summary=('이번 기록에서 계산 가능한 말하기 관찰값을 정리했어요.' if axes else
                 '이번 기록에는 설명할 수 있는 발화 측정값이 없어요. 남겨진 대화와 녹음을 확인해 주세요.'),
        axisComments={name: f"{AXIS_DEFINITIONS.get(name, name)}을 살펴보는 항목으로, 계산된 값은 {v['score']}점이에요."
                      for name, v in axes.items()},
        caveats=('자동 설명을 확인하지 못해 측정값에 따른 설명을 표시해요. ' if issue else '') +
                '측정하지 못한 항목은 제외했어요. 한 번의 기록으로 건강 상태나 이전보다 달라졌는지를 판단하지 않아요.',
        recommendation='대화 내용과 녹음 환경을 함께 살펴봐 주세요.',
        verified=False, verifyIssues=[issue] if issue else [],
    )


def generate_portal_explanation(report):
    from src.agents.analysis.scoring import interpret, verify_agent
    from src.agents.analysis.scoring.interpretation_schema import shape_issues
    from src.common.llm import chat
    from src.rag.corpus import Evidence
    scored = measured_input(report)
    if not scored['axes']:
        return factual_explanation(report)
    evidence = {}
    for index, (name, value) in enumerate(scored['axes'].items()):
        definition = verify_agent.AXIS_DEFINITIONS.get(name, name)
        evidence[name] = [Evidence(
            id=f'observed-axis-{index}', kind='observed', axes=(name,),
            text=f"{name}은 {definition}을 관찰하는 항목이다. 이번 계산값은 {value['score']}점이다. "
                 '지표별 원측정값은 이 설명에 제공되지 않았다. 해당 능력의 정상 여부, 좋고 나쁨, '
                 '지난 기록 대비 변화는 확인되지 않았다. 녹음 환경과 실제 응답을 함께 확인한다.',
            cite='이번 리포트에서 표시하는 측정값',
        )]
    try:
        # Portal inputs contain released scores, not the raw features or a clinical rubric.
        # Keep this prompt separate from the full research interpretation prompt.
        system = ('당신은 가족에게 이번 기록의 관찰 항목을 설명합니다. 제공된 항목 정의와 계산값만 '
                  '쉬운 한국어로 풀어 쓰세요. 점수의 좋고 나쁨, 건강 상태, 원인, 과거 대비 변화는 '
                  '추정하지 않습니다. 총점이나 등급을 만들지 않습니다. 측정되지 않은 세부 지표를 '
                  '측정했다고 쓰지 않습니다. 항목별 설명에는 제공된 근거 ID를 괄호로 붙입니다. '
                  '점수를 쓰는 모든 문장에 해당 항목 이름을 반드시 함께 쓰세요. '
                  '예: [항목 이름]의 이번 점수는 [실제 점수]점입니다. '
                  '각 항목 설명은 정의와 점수를 연결한 한 문장으로 쓰세요. '
                  'JSON 객체만 반환하세요: summary(이번 기록의 항목을 안내하는 한 문장), '
                  'axis_comments(제공된 모든 항목 이름을 키로, 항목 정의와 실제 점수만 설명), '
                  'caveats(녹음 환경과 한 시점 관찰의 한계), recommendation(실제 응답 확인 안내).')
        prompt = '\n'.join(f'({e.id}) {e.text}' for rows in evidence.values() for e in rows)
        value = interpret._parse_json(chat('solar', system, prompt,
                                           temperature=0, max_tokens=1800, timeout=40, retries=0))
        if shape_issues(value):
            raise ValueError('explanation_schema')
        # Require one comment for every released axis and no withheld/new axes.
        if set(value.get('axis_comments', {})) != set(scored['axes']):
            raise ValueError('explanation_axis_scope')
        verdict = verify_agent.verify_report(value, scored, evidence, use_llm=True)
        if not verdict.get('pass'):
            return factual_explanation(report, 'generated_explanation_not_accepted')
        return Interpretation(summary=value['summary'], axisComments=value['axis_comments'],
                              caveats=value.get('caveats', ''), recommendation=value.get('recommendation', ''),
                              evidenceIds={axis: [e.id for e in rows] for axis, rows in evidence.items()},
                              verified=True)
    except Exception as exc:
        return factual_explanation(report, 'explanation_failed_' + type(exc).__name__)
