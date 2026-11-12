"""Persistent conservative quotas. Stores counts, timestamps and client hashes only."""
import datetime
import hashlib
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager


class QuotaExceeded(Exception):
    def __init__(self, reason):
        self.reason = reason


class Quotas:
    def __init__(self, path, global_calls=300, global_tokens=2_000_000, client_calls=30, per_minute=6):
        self.path, self.global_calls, self.global_tokens = str(path), global_calls, global_tokens
        self.client_calls, self.per_minute = client_calls, per_minute
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, day TEXT, at REAL, client TEXT, tokens INTEGER)')
            db.execute('CREATE INDEX IF NOT EXISTS usage_day ON usage(day)')

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def reserve(self, client, tokens, now=None):
        now = time.time() if now is None else now
        day = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime('%Y-%m-%d')
        digest = hashlib.sha256(client.encode()).hexdigest()[:24]
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count, total = db.execute('SELECT COUNT(*), COALESCE(SUM(tokens),0) FROM usage WHERE day=?', (day,)).fetchone()
            mine = db.execute('SELECT COUNT(*) FROM usage WHERE day=? AND client=?', (day, digest)).fetchone()[0]
            recent = db.execute('SELECT COUNT(*) FROM usage WHERE at>? AND client=?', (now - 60, digest)).fetchone()[0]
            if count >= self.global_calls or total + tokens > self.global_tokens:
                raise QuotaExceeded('daily_global_limit')
            if mine >= self.client_calls:
                raise QuotaExceeded('daily_client_limit')
            if recent >= self.per_minute:
                raise QuotaExceeded('rate_limit')
            reservation = uuid.uuid4().hex
            db.execute('INSERT INTO usage VALUES(?,?,?,?,?)', (reservation, day, now, digest, tokens))
            db.execute('DELETE FROM usage WHERE at<?', (now - 7 * 86400,))
        return reservation

    def settle(self, reservation, tokens):
        with self.lock, self.connect() as db:
            db.execute('UPDATE usage SET tokens=? WHERE id=?', (max(0, int(tokens)), reservation))

    def public_limits(self):
        return {'requests_per_minute': self.per_minute, 'requests_per_client_day': self.client_calls,
                'requests_global_day': self.global_calls, 'tokens_global_day': self.global_tokens, 'day_boundary': 'UTC'}
