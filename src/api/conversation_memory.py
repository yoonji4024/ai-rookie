"""Account-scoped, source-bound conversation continuation. No inferred promises."""
import json
import time

NEXT_MEETINGS = {'': '', 'tomorrow': '내일 다시 함께 보기', 'whenever': '편할 때 다시 함께 보기'}


def read_memory(db, owner):
    with db() as c:
        pref = c.execute('SELECT forgotten_before FROM dialogue_memory_preferences WHERE owner_id=?', (owner,)).fetchone()
        cutoff = pref['forgotten_before'] if pref else 0
        rows = c.execute("SELECT id,created,report FROM watches WHERE owner_id=? AND status='complete' AND created>? ORDER BY created DESC LIMIT 20",
                         (owner, cutoff)).fetchall()
        welcomes = c.execute("SELECT created,record FROM welcomes WHERE owner_id=? AND record IS NOT NULL AND created>? ORDER BY created DESC LIMIT 20", (owner, cutoff)).fetchall()
    previous = promise = None
    promise_seen = False
    for row in welcomes:
        payload = json.loads(row['record'])
        for item in reversed(payload.get('items', [])):
            text = item.get('userAnswer', '').strip()
            if (item.get('id') in {'s-daily-plan', 'm-previous-dialogue'} and
                    item.get('state') == 'recorded' and text and item.get('recordingUrl')):
                previous = {'quote': text[:160] + ('…' if len(text) > 160 else ''),
                            'title': '지난 인사', 'createdAt': row['created'],
                            'date': payload.get('reference', {}).get('date'),
                            'timezone': payload.get('reference', {}).get('timezone')}
                break
        if previous:
            break
    for row in rows:
        payload = json.loads(row['report'])
        if not promise_seen and 'nextMeeting' in payload:
            promise_seen = True
            if payload['nextMeeting'] in {'tomorrow', 'whenever'}:
                promise = {'text': NEXT_MEETINGS[payload['nextMeeting']], 'createdAt': row['created'], 'watchId': row['id']}
        if previous is None:
            for item in reversed(payload.get('report', {}).get('questions', [])):
                text = item.get('userAnswer', '').strip()
                if text and item.get('recordingUrl') and item.get('transcriptSource', 'recorded') == 'recorded':
                    previous = {'quote': text[:160] + ('…' if len(text) > 160 else ''),
                                'title': payload['title'], 'createdAt': row['created'], 'watchId': row['id']}
                    break
        if previous and promise_seen:
            break
    return {'previous': previous, 'promise': promise}


def memory_prompts(db, owner, today=None, timezone=None):
    memory = read_memory(db, owner)
    prompts = []
    if memory['previous']:
        p = memory['previous']
        prefix = '지난번'
        if today and p.get('date') and p.get('timezone') == timezone:
            from datetime import date
            gap = (date.fromisoformat(today) - date.fromisoformat(p['date'])).days
            prefix = '어제' if gap == 1 else '조금 전' if gap == 0 else '지난번'
        prompts.append({'id': 'm-previous-dialogue',
                        'question': f"{prefix} ‘{p['quote']}’라고 말씀해 주셨어요. 그 뒤로 어떻게 지내셨어요? 이어서 들려주세요."})
    if memory['promise']:
        p = memory['promise']
        # Never claim that a relative-date promise is due today.
        prompts.append({'id': 'm-next-meeting',
                        'question': f"지난번에는 ‘{p['text']}’를 골라 주셨어요. 오늘도 함께 보고 싶은 영상이 있나요?"})
    return prompts


def install_memory_routes(app, db, user):
    from fastapi import Request
    with db() as c:
        c.execute('CREATE TABLE IF NOT EXISTS dialogue_memory_preferences(owner_id TEXT PRIMARY KEY, forgotten_before REAL NOT NULL)')

    @app.get('/api/memory')
    def state(req: Request):
        return read_memory(db, user(req, 'user')['id'])

    @app.post('/api/memory/clear')
    def clear(req: Request):
        owner = user(req, 'user')['id']
        with db() as c:
            c.execute('INSERT INTO dialogue_memory_preferences VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET forgotten_before=excluded.forgotten_before',
                      (owner, time.time()))
            # Invalidate ready welcome plans too: no stale quotation after forgetting.
            c.execute("DELETE FROM welcomes WHERE owner_id=? AND status='ready'", (owner,))
        return {'ok': True, 'notice': '다음 인사에 쓰는 기억을 지웠어요. 가족과 공유한 리포트는 유지돼요.'}
