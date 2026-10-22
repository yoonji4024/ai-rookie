"""Decode one unambiguous JSON container without repairing its syntax or values."""
import json
import math
import re


def _pairs(items):
    result={}
    for key,value in items:
        if key in result:raise ValueError('Duplicate JSON key')
        result[key]=value
    return result


def _constant(value):raise ValueError('Non-finite JSON constant')


def _check(value):
    if isinstance(value,float) and not math.isfinite(value):raise ValueError('Non-finite JSON number')
    if isinstance(value,dict):
        for item in value.values():_check(item)
    elif isinstance(value,list):
        for item in value:_check(item)


def _decoder():return json.JSONDecoder(object_pairs_hook=_pairs,parse_constant=_constant)


def strict_container(text):
    value=_decoder().decode(text)
    if not isinstance(value,(dict,list)):raise ValueError('Container root required')
    _check(value)
    return value


def bounded_container(text):
    """Read the first container once; never hunt inside a malformed outer one.

    Non-JSON prose and complete non-JSON bracket labels may follow. JSON-like
    suffixes are conservatively ambiguous, even when part of explanatory prose.
    Syntax and string values are not repaired. This is not a semantic validator.
    """
    if not isinstance(text,str):raise ValueError('Text required')
    text=re.sub(r'^```(?:json)?\s*','',text.strip(),count=1,flags=re.I)
    start=re.search(r'[\[{]',text)
    if not start:raise ValueError('Missing container')
    value,end=_decoder().raw_decode(text,start.start())
    if not isinstance(value,(dict,list)):raise ValueError('Container root required')
    _check(value)
    suffix=text[end:]
    pos=0
    while pos<len(suffix):
        char=suffix[pos]
        if char in '{}]':raise ValueError('Ambiguous suffix delimiter')
        if char=='[':
            close=suffix.find(']',pos+1)
            if close<0:raise ValueError('Incomplete suffix label')
            body=suffix[pos+1:close].strip()
            if not body or any(c in body for c in '[]{}'):
                raise ValueError('Ambiguous suffix structure')
            if re.match(r'^(?:["\'0-9+\-.]|true\b|false\b|null\b|NaN\b|Infinity\b)',body):
                raise ValueError('JSON-like suffix array')
            pos=close+1
        else:pos+=1
    return value
