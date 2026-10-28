"""Login conversation records, separate from video scores. No provider calls.

Calendar references are frozen on the server in the device-declared timezone.
Place observations describe language only; they never establish actual location.
"""
import json
import secrets
import time
import wave
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from src.api.recording_store import save_recordings, bind_recordings, read_recordings

PROMPTS = [
    {'id': 'o-date-weekday', 'question': '오늘은 몇 년 몇 월 며칠, 무슨 요일인지 같이 떠올려 볼까요?'},
    {'id': 'o-place', 'question': '지금 어디에서 함께 보고 계세요? 편하게 들려주세요.'},
    {'id': 's-daily-plan', 'question': '오늘은 어떻게 지내실 예정이에요? 하고 싶은 일이나 다녀오실 곳이 있으면 들려주세요.'},
]


class WelcomeStart(BaseModel):
    timezone: str = Field(min_length=1, max_length=100)


def install_welcome_routes(app, backend, root, db, user, allowed, session_hash, memory_provider=None):
    with db() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS welcomes(
            id TEXT PRIMARY KEY, owner_id TEXT, session_hash TEXT UNIQUE,
            created REAL, reference TEXT, status TEXT, record TEXT)''')

    def public(row):
        if row is None:
            return {'state': 'needed'}
        return {'id': row['id'], 'state': row['status'], 'prompts': json.loads(row['reference']).get('prompts', PROMPTS[:2])}

    @app.get('/api/welcome')
    def state(req: Request):
        who = user(req, 'user')
        with db() as c:
            row = c.execute('SELECT * FROM welcomes WHERE session_hash=? AND owner_id=?',
                            (session_hash(req), who['id'])).fetchone()
        return public(row)

    @app.post('/api/welcome/start')
    def start(body: WelcomeStart, req: Request):
        who = user(req, 'user')
        try:
            zone = ZoneInfo(body.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(422, '기기의 시간대 설정을 확인해 주세요.')
        now = time.time()
        local = datetime.fromtimestamp(now, zone)
        reference = {'timezone': body.timezone, 'date': local.date().isoformat(),
                     'keywords': [f'{local.year}년', f'{local.month}월', f'{local.day}일',
                                  '월화수목금토일'[local.weekday()] + '요일'],
                     'source': 'server_clock_device_declared_timezone'}
        remembered = memory_provider(who['id'], reference['date'], body.timezone) if memory_provider else []
        # With a previous conversation, start with its follow-up instead of repeating
        # the generic small talk. Orientation remains separate and optional.
        small_talk = dict(PROMPTS[2])
        if local.hour >= 12:
            small_talk['question'] = '오늘은 어떻게 지내셨어요? 기억에 남는 일이나 다녀오신 곳이 있으면 들려주세요.'
        reference['prompts'] = (remembered + PROMPTS[:2])[:4] if remembered else [small_talk] + PROMPTS[:2]
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('INSERT OR IGNORE INTO welcomes VALUES(?,?,?,?,?,?,NULL)',
                      (secrets.token_hex(16), who['id'], session_hash(req), now,
                       json.dumps(reference, ensure_ascii=False), 'ready'))
            row = c.execute('SELECT * FROM welcomes WHERE session_hash=? AND owner_id=?',
                            (session_hash(req), who['id'])).fetchone()
        return public(row)  # never reveal answers while the conversation is ongoing

    @app.post('/api/welcome/finish')
    def finish(req: Request, welcomeId: str = Form(...), answers: str = Form(...),
               audio: list[UploadFile] = File(default=[])):
        who = user(req, 'user')
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM welcomes WHERE id=? AND owner_id=? AND session_hash=?',
                            (welcomeId, who['id'], session_hash(req))).fetchone()
            if not row:
                raise HTTPException(404, '이번 로그인에 연결된 대화를 찾을 수 없어요.')
            if row['status'] in {'complete', 'partial', 'skipped'}:
                return {'state': row['status']}  # idempotent, no second provider call
            if row['status'] != 'ready':
                raise HTTPException(409, '기록을 확인하고 있어요. 영상을 먼저 보셔도 괜찮아요.')
            try:
                incoming = json.loads(answers)
            except ValueError:
                raise HTTPException(422, '대화 형식을 확인해 주세요.')
            frozen_prompts = json.loads(row['reference']).get('prompts', PROMPTS[:2])
            pmap = {p['id']: p for p in frozen_prompts}
            if not isinstance(incoming, list) or len(incoming) > len(frozen_prompts) or not all(isinstance(i, dict) for i in incoming):
                raise HTTPException(422, '대화 형식을 확인해 주세요.')
            ids = [i.get('id') for i in incoming]
            if not all(isinstance(i, str) and i in pmap for i in ids) or len(set(ids)) != len(ids):
                raise HTTPException(422, '대화 연결을 확인해 주세요.')
            names = [f.filename for f in audio]
            if len(audio) > len(frozen_prompts) or len(set(names)) != len(names) or any(n not in {i + '.wav' for i in ids} for n in names):
                raise HTTPException(422, '녹음과 대화의 연결을 확인해 주세요.')
            for item in incoming:
                if (not isinstance(item.get('userAnswer', ''), str) or len(item.get('userAnswer', '')) > 2000
                        or item.get('state') not in {'recorded', 'untranscribed', 'silent', 'skipped'}):
                    raise HTTPException(422, '대화 내용을 확인해 주세요.')
                has_audio = item['id'] + '.wav' in names
                if (item['state'] in {'recorded', 'untranscribed'}) != has_audio:
                    raise HTTPException(422, '목소리와 대화의 연결을 확인해 주세요.')
                if item['state'] == 'recorded' and not item.get('userAnswer', '').strip():
                    raise HTTPException(422, '글로 확인되지 않은 녹음은 미확인으로 저장해 주세요.')
                if item['state'] != 'recorded' and item.get('userAnswer', '').strip():
                    raise HTTPException(422, '미확인 대화에 답변을 넣을 수 없어요.')
            for f in audio:
                try:
                    f.file.seek(0, 2)
                    if f.file.tell() > 15_000_000:
                        raise ValueError('size')
                    f.file.seek(0)
                    with wave.open(f.file, 'rb') as w:
                        if (w.getnchannels() != 1 or w.getsampwidth() != 2 or
                                not .6 <= w.getnframes() / w.getframerate() <= 65):
                            raise ValueError('format or duration')
                        if len(w.readframes(w.getnframes())) != w.getnframes() * 2:
                            raise ValueError('truncated')
                except (ValueError, EOFError, wave.Error, ZeroDivisionError):
                    raise HTTPException(422, '녹음 파일을 확인해 주세요.')
                finally:
                    f.file.seek(0)
            c.execute('UPDATE welcomes SET status=? WHERE id=?', ('processing', welcomeId))
        directory = root / 'welcome_recordings' / welcomeId
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            reference = json.loads(row['reference'])
            source = {i['id']: i for i in incoming}
            items = []
            for p in frozen_prompts:
                supplied = source.get(p['id'], {'state': 'skipped', 'userAnswer': ''})
                items.append({**p, 'state': supplied['state'], 'userAnswer': supplied.get('userAnswer', ''),
                              'audioFilename': p['id'] + '.wav' if p['id'] + '.wav' in names else '',
                              'answerKeywords': reference['keywords'] if p['id'] == 'o-date-weekday' else []})
            save_recordings(audio, directory)
            bound, _ = bind_recordings(items, directory)
            scored = backend._score_orientation_answers([item for item in bound if item['id'].startswith('o-')])
            observations = scored['detail'] if scored else {'questions': [], 'measured': 0}
            captured = sum(i['state'] in {'recorded', 'untranscribed'} for i in items)
            status = 'complete' if all(i['state'] == 'recorded' for i in items) else 'partial' if captured else 'skipped'
            record = {'id': welcomeId, 'createdAt': row['created'], 'status': status,
                      'reference': {k: v for k, v in reference.items() if k not in {'keywords', 'prompts'}},
                      'observations': observations, 'validated': False,
                      'notice': '날짜·요일은 대화 시작 시 서버 시각과 기기 시간대를 기준으로 비교해요. 장소는 표현만 살펴보며 실제 위치는 확인하지 않아요. 건너뛴 대화와 확인되지 않은 음성은 오답으로 세지 않아요. 이 기록은 진단 결과가 아니에요.',
                      'items': [{k: v for k, v in i.items() if k not in {'answerKeywords', 'audioFilename', 'audioAssociation'}} |
                                {'recordingUrl': f'/api/score/welcome/audio/{welcomeId}/{i["audioFilename"]}' if i['audioFilename'] else None}
                                for i in bound]}
            with db() as c:
                c.execute('UPDATE welcomes SET status=?, record=? WHERE id=?',
                          (status, json.dumps(record, ensure_ascii=False), welcomeId))
        except Exception:
            with db() as c:
                c.execute('UPDATE welcomes SET status=? WHERE id=?', ('failed', welcomeId))
            raise HTTPException(500, '기록을 마무리하지 못했어요. 영상을 먼저 보셔도 괜찮아요.')
        return {'state': status}

    @app.get('/api/family/welcomes/{owner_id}')
    def history(owner_id: str, req: Request):
        who = user(req)
        with db() as c:
            if not allowed(c, who, owner_id):
                raise HTTPException(403, '연결된 가족의 기록만 볼 수 있어요.')
            rows = c.execute('SELECT record FROM welcomes WHERE owner_id=? AND record IS NOT NULL ORDER BY created DESC LIMIT 20', (owner_id,)).fetchall()
        return [json.loads(r['record']) for r in rows]

    @app.get('/api/welcome/audio/{welcome_id}/{filename}')
    def recording(welcome_id: str, filename: str, req: Request):
        who = user(req)
        with db() as c:
            row = c.execute('SELECT owner_id FROM welcomes WHERE id=?', (welcome_id,)).fetchone()
            if not row or not allowed(c, who, row['owner_id']):
                raise HTTPException(404, '녹음을 찾을 수 없어요.')
        directory = root / 'welcome_recordings' / welcome_id
        valid = {r['stored_filename'] for r in read_recordings(directory) if r.get('complete')}
        path = directory / filename
        if filename not in valid or not path.is_file() or path.is_symlink():
            raise HTTPException(404, '녹음을 찾을 수 없어요.')
        return FileResponse(path, media_type='audio/wav')
