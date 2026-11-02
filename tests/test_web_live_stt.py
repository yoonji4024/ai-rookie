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
    app=FastAPI();install_live_stt(app,db,{ORIGIN},connect,web_origins={'http://127.0.0.1:5173','http://localhost:5173'})
    return TestClient(app),providers,db,mode


WEB='http://127.0.0.1:5173'
COOKIE='w'*44

def web_session(setup):
    client,providers,db,mode=setup
    with db() as c:
        c.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(COOKIE.encode()).hexdigest(),'owner',time.time()+1000))
    return client,providers,db,mode

def web_start(c,origin=WEB,cookie=COOKIE):
    return c.websocket_connect('/api/stt/live',headers={'Origin':origin,'Cookie':'earlyear_session='+cookie})

def test_web_cookie_pcm_end_to_end(setup):
    c,p,_,_=web_session(setup)
    with web_start(c) as ws:
        ws.send_json({'type':'start'});assert ws.receive_json()=={'type':'ready'}
        ws.send_bytes(b'\0\0'*1600);ws.send_text('{"type":"stop"}')
        assert ws.receive_json()['text']=='작성된 검증 문장'
    assert len(p)==1 and p[0].closed and 'keywords' not in p[0].sent[0]

@pytest.mark.parametrize('mode',['missing','expired','guardian','extension_cookie'])
def test_web_auth_denies_before_provider(setup,mode):
    c,p,db,_=web_session(setup)
    with db() as s:
        if mode=='expired':s.execute('UPDATE sessions SET expires=0')
        if mode=='guardian':s.execute("UPDATE users SET role='guardian'")
    with web_start(c,cookie='' if mode=='missing' else TOKEN if mode=='extension_cookie' else COOKIE) as ws:
        ws.send_json({'type':'start'})
        with pytest.raises(WebSocketDisconnect):ws.receive_json()
    assert p==[]

@pytest.mark.parametrize('origin',['https://evil.example','null','http://127.0.0.1:5193'])
def test_web_foreign_origins_denied(setup,origin):
    c,p,_,_=web_session(setup)
    with pytest.raises(WebSocketDisconnect):
        with web_start(c,origin=origin):pass
    assert p==[]

def test_logout_revokes_web_stream_before_next_chunk(setup):
    c,p,db,_=web_session(setup)
    with web_start(c) as ws:
        ws.send_json({'type':'start'});assert ws.receive_json()=={'type':'ready'}
        with db() as s:s.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(COOKIE.encode()).hexdigest(),))
        ws.send_bytes(b'\0\0'*1600);assert ws.receive_json()['type']=='error'
    assert len(p[0].sent)==1

def test_web_cannot_send_hints(setup):
    c,p,_,_=web_session(setup)
    with web_start(c) as ws:
        ws.send_json({'type':'start','keywords':['correct answer']})
        assert ws.receive_json()['type']=='error'
    assert p==[]

def test_web_and_extension_share_one_active_slot(setup):
    c,p,_,_=web_session(setup)
    with web_start(c) as first:
        first.send_json({'type':'start'});assert first.receive_json()=={'type':'ready'}
        with c.websocket_connect('/api/stt/live',headers={'Origin':ORIGIN}) as second:
            second.send_json({'type':'start','token':TOKEN})
            with pytest.raises(WebSocketDisconnect):second.receive_json()
        assert len(p)==1
    with web_start(c) as again:
        again.send_json({'type':'start'});assert again.receive_json()=={'type':'ready'}
    assert len(p)==2 and all(item.closed for item in p)
