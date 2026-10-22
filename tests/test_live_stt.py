import asyncio
from contextlib import contextmanager
import hashlib
import json
import sqlite3
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect
from src.api.live_stt import install_live_stt, MAX_CHUNK

ORIGIN='chrome-extension://'+'a'*32
TOKEN='t'*44

class Provider:
    def __init__(self, mode='final'):
        self.queue=asyncio.Queue();self.sent=[];self.closed=False;self.mode=mode
    async def send(self, raw):
        row=json.loads(raw);self.sent.append(row)
        if row['message_type']=='create':
            self.queue.put_nowait({'message_type':'created','code':0})
        if row['message_type']=='audio' and self.mode=='early':
            self.queue.put_nowait({'message_type':'stopped'})
        if row['message_type']=='stop':
            self.queue.put_nowait({'message_type':'transcript','text':'작성된 검증 문장','final':self.mode=='final'})
            self.queue.put_nowait({'message_type':'stopped'})
    async def recv(self):return json.dumps(await self.queue.get())
    def __aiter__(self):return self
    async def __anext__(self):return await self.recv()
    async def close(self):self.closed=True

@pytest.fixture
def setup(tmp_path):
    path=tmp_path/'db'
    @contextmanager
    def db():
        c=sqlite3.connect(path);c.row_factory=sqlite3.Row
        try:
            with c:yield c
        finally:c.close()
    with db() as c:
        c.executescript('CREATE TABLE users(id,role); CREATE TABLE sessions(token_hash,user_id,expires); CREATE TABLE extension_sessions(token_hash,extension_origin);')
        digest=hashlib.sha256(TOKEN.encode()).hexdigest()
        c.execute('INSERT INTO users VALUES(?,?)',('owner','user'))
        c.execute('INSERT INTO sessions VALUES(?,?,?)',(digest,'owner',time.time()+1000))
        c.execute('INSERT INTO extension_sessions VALUES(?,?)',(digest,ORIGIN))
    providers=[];mode=['final']
    async def connect():
        p=Provider(mode[0]);providers.append(p);return p
    app=FastAPI();install_live_stt(app,db,{ORIGIN},connect)
    return TestClient(app),providers,db,mode

def start(client, token=TOKEN, origin=ORIGIN):
    return client.websocket_connect('/api/stt/live',headers={'Origin':origin})

def ready(ws):
    ws.send_json({'type':'start','token':TOKEN})
    assert ws.receive_json()=={'type':'ready'}

@pytest.mark.parametrize('origin',['https://www.youtube.com','null','http://127.0.0.1:5173'])
def test_wrong_origin_never_connects_provider(setup,origin):
    c,p,_,_=setup
    with pytest.raises(WebSocketDisconnect):
        with start(c,origin=origin):pass
    assert p==[]

@pytest.mark.parametrize('invalid',['bad_token','expired','guardian','web_session','wrong_extension'])
def test_authentication_before_provider(setup,invalid):
    c,p,db,_=setup
    with db() as s:
        if invalid=='expired':s.execute('UPDATE sessions SET expires=0')
        if invalid=='guardian':s.execute("UPDATE users SET role='guardian'")
        if invalid=='web_session':s.execute('DELETE FROM extension_sessions')
        if invalid=='wrong_extension':s.execute("UPDATE extension_sessions SET extension_origin='chrome-extension://other'")
    with start(c) as ws:
        ws.send_json({'type':'start','token':'x'*44 if invalid=='bad_token' else TOKEN})
        with pytest.raises(WebSocketDisconnect):ws.receive_json()
    assert p==[]

def test_final_and_one_stop_no_hints(setup):
    c,p,_,_=setup
    with start(c) as ws:
        ready(ws);ws.send_bytes(b'\0\0'*1600);ws.send_text('{"type":"stop"}')
        assert ws.receive_json()=={'type':'done','text':'작성된 검증 문장'}
    assert [r['message_type'] for r in p[0].sent]==['create','audio','stop']
    assert 'keywords' not in p[0].sent[0] and p[0].closed

@pytest.mark.parametrize('mode',['partial','early'])
def test_partial_or_premature_stop_is_not_success(setup,mode):
    c,p,_,m=setup;m[0]=mode
    with start(c) as ws:
        ready(ws);ws.send_bytes(b'\0\0'*1600)
        if mode=='partial':ws.send_text('{"type":"stop"}')
        assert ws.receive_json()['type']=='error'
    assert len(p)==1 and p[0].closed

@pytest.mark.parametrize('chunk',[b'x',b'\0'*(MAX_CHUNK+2),b''])
def test_bad_pcm_never_forwarded(setup,chunk):
    c,p,_,_=setup
    with start(c) as ws:
        ready(ws);ws.send_bytes(chunk);assert ws.receive_json()['type']=='error'
    assert len(p[0].sent)==1 and p[0].closed

def test_revoked_session_cannot_forward_audio(setup):
    c,p,db,_=setup
    with start(c) as ws:
        ready(ws)
        with db() as s:s.execute('DELETE FROM sessions')
        ws.send_bytes(b'\0\0'*1600);assert ws.receive_json()['type']=='error'
    assert len(p[0].sent)==1

def test_concurrent_owner_rejected_and_cancel_releases(setup):
    c,p,_,_=setup
    with start(c) as first:
        ready(first)
        with start(c) as second:
            second.send_json({'type':'start','token':TOKEN})
            with pytest.raises(WebSocketDisconnect):second.receive_json()
        assert len(p)==1
    assert p[0].closed
    with start(c) as again:
        ready(again)
    assert len(p)==2 and p[1].closed
