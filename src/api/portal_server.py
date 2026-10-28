"""MEMFLIX web + extension entry point. Run from the repository root."""
import json
import os
from pathlib import Path

from src.common.llm import load_env

ROOT = Path(__file__).resolve().parents[2]
load_env(str(ROOT / '.env'))

from src.api import server
from src.api.portal import create_portal
from src.api.runtime_stt import transcribe_once

# Same runtime implementation as the reviewed 10/15 deployment, with portable
# package imports instead of an absolute server path and dynamic candidate loader.
server._stt = transcribe_once
_backend_health = server._health

def _health():
    return {**_backend_health(), 'extension_version': '0.3.8',
            'browser_stt': 'authenticated_live_pcm',
            'dialogue_copy_revision': 'closing-20261015'}

server._health = _health
store = Path(os.environ.get('MEMFLIX_DATA_DIR') or ROOT / 'data/memflix/private').expanduser().resolve()
# Keep legacy analysis scratch output separate from account-authorized records.
server.LIVE_ROOT = store / 'analysis'
server.HISTORY_DB_PATH = server.LIVE_ROOT / 'history.sqlite3'
connection = json.loads((ROOT / 'apps/extension/extension/connection.json').read_text())
app = create_portal(server, store, extension_origins=[connection['origin']])
app.title = 'MEMFLIX account portal'
