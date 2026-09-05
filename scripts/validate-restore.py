import hashlib, json, os, pathlib, sys, tarfile
backup, pg, storage, override = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:])
targets = [pg, storage]
for target in targets:
    if target in [pathlib.Path('/'), pathlib.Path.home(), pathlib.Path.cwd()] or target in pathlib.Path.cwd().parents:
        raise SystemExit(f'Unsafe restore target: {target}')
    if target == backup or target in backup.parents or backup in target.parents:
        raise SystemExit('Restore targets cannot overlap the backup')
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise SystemExit(f'Restore target is not empty: {target}')
if pg == storage or pg in storage.parents or storage in pg.parents:
    raise SystemExit('Database and storage targets must not overlap')
if override.exists(): raise SystemExit(f'Refusing to overwrite {override}')
if any(target == override or target in override.parents for target in targets):
    raise SystemExit('The Compose override must be outside the data targets')
required = {'database.dump', 'storage.tar.gz', 'manifest.json', 'inventory.jsonl'}
checks = {}
for line in (backup / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split(maxsplit=1)
    name = name.lstrip('*')
    if name not in required | {'secrets.env.age'}: raise SystemExit('Unexpected checksum path')
    if name in checks: raise SystemExit('Duplicate checksum path')
    checks[name] = digest
if not required <= checks.keys(): raise SystemExit('Incomplete checksum manifest')
for name, expected in checks.items():
    with (backup / name).open('rb') as stream:
        h = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
        if h.hexdigest() != expected: raise SystemExit(f'Checksum failed: {name}')
if json.loads((backup / 'manifest.json').read_text()).get('format_version') != 3:
    raise SystemExit('This restore requires a verified format-3 backup; retain older backups for manual recovery')
with tarfile.open(backup / 'storage.tar.gz') as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit(f'Unsafe archive entry: {member.name}')
for target in targets: target.mkdir(parents=True, exist_ok=True)
override.parent.mkdir(parents=True, exist_ok=True)
# Persistent override prevents later compose commands reverting to old mounts.
with override.open('x') as stream:
    json.dump({'services': {'db': {'volumes': [f'{pg}:/var/lib/postgresql/data']},
                             'storage': {'volumes': [f'{storage}:/data']}}}, stream)
os.chmod(override, 0o600)
