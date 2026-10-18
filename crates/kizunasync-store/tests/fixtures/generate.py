"""Generate SQLite fixtures with Python's original SQLite engine, never Turso.

Run once from any directory; checked-in bytes let every Rust CI host test the
old engine's file and WAL without installing Python or a second SQL runtime.
"""
import json, os, pathlib, re, sqlite3, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[3]
SCHEMA = re.search(r'SCHEMA: &str = r"(.*?)";', (REPO/'crates/kizunasync-store/src/schema.rs').read_text(), re.S).group(1)
STAMP = '2026-10-16T00:00:00Z'
def insert(c,t,**kw):
 c.execute('INSERT INTO "'+t+'" ('+','.join('"'+k+'"' for k in kw)+') VALUES ('+','.join('?' for _ in kw)+')',list(kw.values()))
def seed(path,old=False,dirty=False):
 c=sqlite3.connect(path);c.execute('pragma journal_mode=WAL');c.execute('pragma synchronous=FULL');c.execute('pragma wal_autocheckpoint=0');c.executescript(SCHEMA)
 if old:c.execute('ALTER TABLE _kizunasync_attachments DROP COLUMN error_code')
 for i in range(10):
  pk=f'offline-{i}';body=json.dumps({'id':pk,'user_id':'u1','title':f'Unsynced edit {i}','unicode':'絆 🧪','done':False},ensure_ascii=False,separators=(',',':'))
  insert(c,'_kizunasync_rows',table_name='todos',pk=pk,row_json=body,updated_seq='9007199254740993')
  insert(c,'_kizunasync_outbox',mutation_id=f'mutation-{i}',table_name='todos',pk=pk,op='insert',columns_json=body,created_at=STAMP,batch_id='batch-1' if i<5 else None,hlc=f'1792108800000|{i}|device-1',in_flight=1 if i==0 else 0)
 for key,value in {'cursor':'900719925474099312345','client_id':'00000000-0000-4000-8000-000000000001','origin_hlc':'1792108800000|9|device-1','last_mutation_id':'mutation-9','custom_nullable_marker':'kept'}.items():insert(c,'_kizunasync_meta',key=key,value=value)
 insert(c,'_kizunasync_tombstones',table_name='todos',pk='deleted-row',seq='9007199254740993',deleted_at=STAMP)
 insert(c,'_kizunasync_rejections',mutation_id='rejected-1',table_name='todos',pk='rejected-row',kind='REJECTED',reason='policy',changed_columns='["title"]',server_row='{"title":"server"}',at=1792108800000)
 insert(c,'_kizunasync_dead_letter',mutation_id='dead-1',table_name='todos',pk='dead-row',op='insert',columns_json='{"title":"dead"}',reason='PERMANENT_TRANSPORT',created_at=STAMP)
 insert(c,'_kizunasync_overwrites',table_name='todos',pk='overwritten',column_name='title',loser_value='"local"',winner_mutation_id='winner-1',conflict_mode='hlc',winner_seq='9007199254740993',at=1792108800000)
 insert(c,'_kizunasync_pushed',mutation_id='already-pushed',pushed_at=STAMP)
 insert(c,'_kizunasync_pull_pages',body='{"cursor":"900719925474099312345","changes":[]}')
 attachment=pathlib.Path('/synthetic/pending-attachment.bin')
 insert(c,'_kizunasync_attachments',ref='attachment-1',upload_id='upload-1',table_name='todos',pk='offline-0',column_name='attachment',bucket='media',owner='user-1',sha256='a'*64,content_type='application/octet-stream',size=7*1024*1024,local_path=str(attachment),direction='upload',state='uploading',fingerprint='fingerprint-1',progress=6291456,attempts=2,chunk_offset=6291456,tus_url='https://example.invalid/synthetic-upload',error='retryable',created_at=STAMP,updated_at=STAMP)
 c.commit()
 if dirty:os._exit(0)
 c.close()

if len(sys.argv) > 1:
    seed(pathlib.Path(sys.argv[1]), dirty=True)
    raise SystemExit()
for name, old, dirty in [('closed', False, False), ('old-schema', True, False), ('dirty-wal', False, True)]:
    path = ROOT / (name + '.fixture')
    for suffix in ['', '-wal', '-shm']:
        pathlib.Path(str(path)+suffix).unlink(missing_ok=True)
    if dirty:
        subprocess.run([sys.executable, __file__, str(path)], check=True)
    else:
        seed(path, old=old)
    # Read a COPY so inspecting the fixture cannot checkpoint its committed WAL.
    import tempfile, shutil
    with tempfile.TemporaryDirectory() as directory:
        copy = pathlib.Path(directory)/'database'
        for suffix in ['', '-wal']:
            source = pathlib.Path(str(path)+suffix)
            if source.exists(): shutil.copyfile(source, str(copy)+suffix)
        connection = sqlite3.connect(copy)
        snapshot = {}
        for table, in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            columns = [row[1] for row in connection.execute('PRAGMA table_info("'+table+'")')]
            rows = list(connection.execute('SELECT * FROM "'+table+'"'))
            snapshot[table] = {'columns': columns, 'rows': rows}
        connection.close()
    (ROOT/(name+'.json')).write_text(json.dumps(snapshot, ensure_ascii=False, indent=2)+'\n')
    pathlib.Path(str(path)+'-shm').unlink(missing_ok=True)
