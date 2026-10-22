"""Validated local batch indices for the semantic-scoring transport.

The caller's question indices never depend on the model's array order.
Unusable responses raise a contract error; the caller may explicitly abstain.
"""
from __future__ import annotations

import json
import math
import re

SYSTEM = (
    "당신은 미디어 시청 후 회상 답변을 채점합니다. 단어가 정확히 같지 않아도 "
    "사용자 답변의 의미가 기준 답변의 질문 핵심과 같으면 1, 핵심 일부만 맞으면 "
    "0.5, 틀리거나 무관하거나 모른다고 하면 0으로 판정하세요. 사용자가 핵심어를 "
    "말했더라도 이를 부정하거나 모른다고 한 경우에는 1을 주지 마세요. 마지막에 "
    "스스로 정정한 경우에는 정정 뒤의 내용을 기준으로 보세요. 기준 답변에 있는 "
    "부가 정보를 사용자가 생략했더라도 질문에 직접 답한 핵심 의미가 맞으면 1입니다. "
    "사용자가 실제로 말하지 않은 내용을 추론해 보충하지 마세요. 설명이나 마크다운 "
    "없이 [{\"index\":0,\"score\":1}] 형태의 JSON 배열만 출력하세요."
)
ALLOWED_SCORES = frozenset({0.0,0.25,0.5,0.75,1.0})


def prepare(items: list[dict], indices: list[int]) -> tuple[list[dict], dict[int,int]]:
    if any(type(i) is not int or not 0 <= i < len(items) for i in indices):
        raise ValueError('Invalid caller index')
    if len(set(indices)) != len(indices):raise ValueError('Duplicate caller index')
    if any(not isinstance(items[i],dict) for i in indices):raise ValueError('Invalid item')
    mapping=dict(enumerate(indices))
    return [{"index":local,"question":str(items[original].get('question','')),
             "referenceAnswer":str(items[original].get('correctAnswer','')),
             "userAnswer":str(items[original].get('userAnswer',''))}
            for local,original in mapping.items()],mapping


def restore(raw: str, mapping: dict[int,int]) -> dict[int,float]:
    text=re.sub(r'^```(?:json)?\s*|\s*```$','',raw.strip(),flags=re.IGNORECASE)
    def invalid_constant(value):raise ValueError('Non-finite JSON')
    rows=json.loads(text,parse_constant=invalid_constant)
    if not isinstance(rows,list) or len(rows)!=len(mapping):raise ValueError('Batch cardinality')
    result={};seen=set()
    for row in rows:
        if not isinstance(row,dict):raise ValueError('Invalid score row')
        index=row.get('index');score=row.get('score')
        if type(index) is not int or index not in mapping or index in seen:raise ValueError('Batch identity')
        if type(score) not in (int,float) or not math.isfinite(score) or score not in ALLOWED_SCORES:
            raise ValueError('Invalid score')
        seen.add(index);result[mapping[index]]=float(score)
    if seen!=set(mapping):raise ValueError('Missing batch score')
    return result


def score(items: list[dict], indices: list[int], provider: str='exaone') -> dict[int,float]:
    if not indices:return {}
    from src.common.llm import chat
    wire,mapping=prepare(items,indices)
    raw=chat(provider,SYSTEM,json.dumps(wire,ensure_ascii=False),temperature=0.0,
             timeout=12,max_tokens=220,retries=1,thinking=False)
    return restore(raw,mapping)
