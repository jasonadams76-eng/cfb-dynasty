DROP TABLE IF EXISTS dynasties;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS chunks;
CREATE TABLE dynasties(
  id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, cap INTEGER DEFAULT 8,
  version INTEGER DEFAULT 0, snap_v INTEGER DEFAULT 0, snap_n INTEGER DEFAULT 0,
  deadline TEXT DEFAULT '', lock_until INTEGER DEFAULT 0, status TEXT DEFAULT '', created INTEGER
);
CREATE TABLE members(
  id TEXT PRIMARY KEY, dyn TEXT, name TEXT, token TEXT, team INTEGER,
  is_host INTEGER DEFAULT 0, ready INTEGER DEFAULT 0, seen INTEGER DEFAULT 0,
  sub_v INTEGER DEFAULT -1, sub_n INTEGER DEFAULT 0, sub_at INTEGER DEFAULT 0
);
CREATE INDEX members_dyn ON members(dyn);
CREATE TABLE chunks(
  dyn TEXT, kind TEXT, key TEXT, v INTEGER, idx INTEGER, data TEXT,
  PRIMARY KEY(dyn,kind,key,v,idx)
);
