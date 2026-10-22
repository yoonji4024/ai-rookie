"""Authenticated, bounded PCM relay. No reference hints, retries or partial success."""
import asyncio
import base64
import hashlib
import json
import ssl
import time
import uuid

from fastapi import WebSocket, WebSocketDisconnect

MAX_PCM = 16000 * 2 * 65
MAX_CHUNK = 16000


async def provider_connect():
    import certifi
    import websockets
    from src.common.stt import AXSTT, WS_BASE
    return await websockets.connect(
        WS_BASE + '/v1/stt/realtime', additional_headers=AXSTT().headers,
        ssl=ssl.create_default_context(cafile=certifi.where()),
        open_timeout=10, close_timeout=2, max_size=65536)


def install_live_stt(app, db, origins, connect=None):
    connect = connect or provider_connect
    active = set()

    def authenticate(token, origin):
        if not isinstance(token, str) or not 40 <= len(token) <= 128:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with db() as c:
            row = c.execute('''SELECT u.id FROM users u
              JOIN sessions s ON s.user_id=u.id
              JOIN extension_sessions e ON e.token_hash=s.token_hash
              WHERE s.token_hash=? AND s.expires>? AND e.extension_origin=? AND u.role='user' ''',
              (digest, time.time(), origin)).fetchone()
        return row['id'] if row else None

    @app.websocket('/api/stt/live')
    async def live(socket: WebSocket):
        origin = socket.headers.get('origin')
        if origin not in origins:
            await socket.close(code=1008)
            return
        await socket.accept()
        upstream = None
        tasks = []
        owner = None
        claimed = False
        try:
            raw = await asyncio.wait_for(socket.receive_text(), 5)
            if len(raw) > 512:
                raise ValueError('start too large')
            start = json.loads(raw)
            if not isinstance(start, dict) or set(start) != {'type','token'} or start['type'] != 'start':
                raise ValueError('invalid start')
            owner = authenticate(start['token'], origin)
            if owner is None:
                await socket.close(code=1008)
                return
            if owner in active:
                await socket.close(code=1008)
                return
            active.add(owner)
            claimed = True
            async with asyncio.timeout(95):
                upstream = await connect()
                from src.common.stt import MODEL_STREAM
                await upstream.send(json.dumps({'message_type':'create','speech_model':MODEL_STREAM,
                    'audio_format':'pcm_16k','vad_type':'semantic','partial':True,
                    'tr_id':'memflix-live-'+uuid.uuid4().hex[:12]}))
                created = json.loads(await asyncio.wait_for(upstream.recv(), 10))
                if created.get('message_type') != 'created' or created.get('code') != 0:
                    raise ValueError('provider create failed')
                await socket.send_json({'type':'ready'})
                stopped = asyncio.Event()
                parts = []

                async def forward():
                    count = 0
                    while True:
                        message = await asyncio.wait_for(socket.receive(), 15)
                        if message['type'] == 'websocket.disconnect':
                            raise WebSocketDisconnect()
                        # Recheck revocation/expiry before forwarding any new PCM.
                        if authenticate(start['token'], origin) != owner:
                            raise ValueError('session ended')
                        chunk = message.get('bytes')
                        if chunk is not None:
                            if not 0 < len(chunk) <= MAX_CHUNK or len(chunk) % 2:
                                raise ValueError('invalid PCM chunk')
                            count += len(chunk)
                            if count > MAX_PCM:
                                raise ValueError('PCM limit')
                            await upstream.send(json.dumps({'message_type':'audio',
                                'data':base64.b64encode(chunk).decode('ascii')}))
                        elif message.get('text') == '{"type":"stop"}' and count:
                            stopped.set()
                            await upstream.send(json.dumps({'message_type':'stop'}))
                            return
                        else:
                            raise ValueError('invalid command')

                async def receive():
                    import websockets
                    try:
                        async for raw in upstream:
                            value = json.loads(raw)
                            kind = value.get('message_type')
                            if kind == 'transcript':
                                text = str(value.get('text','')).strip()
                                if len(text) > 4000:
                                    raise ValueError('transcript limit')
                                if text and value.get('final') is True:
                                    if not parts or parts[-1] != text:
                                        parts.append(text)
                            elif kind == 'stopped':
                                return
                            elif value.get('code',0) not in (0,None):
                                raise ValueError('provider rejected')
                    except websockets.exceptions.ConnectionClosed:
                        if not stopped.is_set() or not parts:
                            raise ValueError('provider closed early')

                sender = asyncio.create_task(forward())
                receiver = asyncio.create_task(receive())
                tasks = [sender, receiver]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                if not stopped.is_set():
                    raise ValueError('provider stopped before recording ended')
                await sender
                await asyncio.wait_for(receiver, 15)
                text = ' '.join(parts).strip()
                if not text or authenticate(start['token'], origin) != owner:
                    raise ValueError('no final transcript or expired session')
                await socket.send_json({'type':'done','text':text})
        except (Exception, asyncio.CancelledError):
            try:
                await socket.send_json({'type':'error','message':'말씀을 글로 확인하지 못했어요. 녹음은 다시 보내지 않았어요.'})
            except Exception:
                pass
        finally:
            # ASGI cancellation must not interrupt provider cleanup or retain the
            # account's active-stream slot after its tab has gone away.
            import anyio
            with anyio.CancelScope(shield=True):
                try:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                    if upstream is not None:
                        try:
                            await asyncio.wait_for(upstream.close(), 3)
                        except Exception:
                            pass
                finally:
                    if claimed:
                        active.discard(owner)
                try:
                    await socket.close()
                except Exception:
                    pass
