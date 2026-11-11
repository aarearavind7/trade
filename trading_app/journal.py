"""A single-user trade journal in the existing application SQLite database."""
import json
from datetime import date, datetime, timezone
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Literal
from .alpaca_client import AlpacaClient
from .service import TradeError


class JournalDraft(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    symbol: str = Field(min_length=1, max_length=10)
    trade_date: date
    status: Literal['planned', 'open', 'closed'] = 'planned'
    thesis: str = Field(min_length=1, max_length=4000)
    expected: str = Field(default='', max_length=4000)
    lessons: str = Field(default='', max_length=4000)

    @field_validator('symbol')
    @classmethod
    def validate_symbol(cls, value):
        return AlpacaClient.symbol(value)


class JournalUpdate(JournalDraft):
    revision: int = Field(ge=1)


class JournalStore:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL)')

    @staticmethod
    def row(row):
        return {**json.loads(row['payload']), 'id': row['id'], 'created_at': row['created_at'], 'updated_at': row['updated_at'], 'revision': row['revision']}

    def list(self, limit=50, offset=0):
        with self.store.connect() as db:
            count = db.execute('SELECT count(*) FROM journal').fetchone()[0]
            rows = db.execute('SELECT * FROM journal ORDER BY updated_at DESC, id LIMIT ? OFFSET ?', (limit, offset)).fetchall()
        return {'entries': [self.row(row) for row in rows], 'total': count, 'offset': offset, 'limit': limit}

    def save(self, draft, entry_id=None):
        now = datetime.now(timezone.utc).isoformat()
        payload = draft.model_dump(mode='json', exclude={'revision'})
        with self.store.connect(write=True) as db:
            if entry_id:
                cursor = db.execute('UPDATE journal SET payload=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?',
                                    (json.dumps(payload), now, entry_id, draft.revision))
                if cursor.rowcount != 1:
                    raise TradeError('This journal entry changed or was deleted. Reload the journal before editing.', 409)
            else:
                if db.execute('SELECT count(*) FROM journal').fetchone()[0] >= 5000:
                    raise TradeError('Journal capacity is 5,000 entries. Remove older entries before adding more.')
                entry_id = str(uuid4())
                db.execute('INSERT INTO journal VALUES (?,?,?,?,1)', (entry_id, json.dumps(payload), now, now))
            return self.row(db.execute('SELECT * FROM journal WHERE id=?', (entry_id,)).fetchone())

    def delete(self, entry_id, revision):
        with self.store.connect(write=True) as db:
            if db.execute('DELETE FROM journal WHERE id=? AND revision=?', (entry_id, revision)).rowcount != 1:
                raise TradeError('This journal entry changed or was deleted. Reload before deleting.', 409)
