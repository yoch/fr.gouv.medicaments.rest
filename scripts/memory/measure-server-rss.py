#!/usr/bin/env python3
"""Mesure mémoire d'un serveur : démarrage, repos, charge, repos après charge."""
import json, os, signal, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.environ.get('MEM_OUT', '/tmp/server-rss')
os.makedirs(OUT, exist_ok=True)
PORT = 3230
# Données lues (et éventuellement re-téléchargées) en place : passer une copie au besoin.
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
VET_DATA_DIR = os.environ.get('VET_DATA_DIR', os.path.join(DATA_DIR, 'veterinaires'))
# Exécutables compilés : chemins par variable d'environnement (MEM_BIN_<VARIANTE>, tirets
# en soulignés). Seul `aot` a un défaut : la sortie de `npm run build:aot`.
def binary(name, default=None):
    return os.environ.get('MEM_BIN_' + name.upper().replace('-', '_'), default)

VARIANTS = {
    'node':       ['node', 'src/server.js'],
    'aot':        [binary('aot', os.path.join(ROOT, 'dist', 'medicaments-api'))],
    'jit':        [binary('jit')],
    'aot-npm':    [binary('aot-npm')],
    'aot-lib':    [binary('aot-lib')],
    'aot-lib-trim': [binary('aot-lib-trim')],
}
PATHS = ','.join([
    '/health',
    '/api/medicaments/search?q=paracetamol&limit=10&detail=summary',
    '/api/medicaments/search?q=doliprane&limit=5&detail=full',
    '/api/medicaments/search?q=dolipranr&source=auto&limit=5',
    '/api/medicaments/search?q=amoxicilline&limit=20&detail=summary',
    '/api/medicaments/search?q=ibuprofene&limit=20&detail=full',
    '/api/medicaments/specialites?limit=20',
    '/api/medicaments/specialites/60234100',
    '/api/medicaments/disponibilite/alerts',
    '/api/veterinaires/medicaments?limit=20',
    '/api-docs.json',
])


def status(pid):
    d = {}
    try:
        for line in open(f'/proc/{pid}/status'):
            k, _, v = line.partition(':')
            if k in ('VmRSS', 'VmHWM', 'VmSize', 'RssAnon', 'RssFile'):
                d[k] = int(v.split()[0]) / 1024
    except FileNotFoundError:
        pass
    return d


def rollup(pid):
    d = {}
    try:
        for line in open(f'/proc/{pid}/smaps_rollup'):
            k, _, v = line.partition(':')
            if k in ('Rss', 'Pss', 'Pss_Anon', 'Pss_File', 'Private_Dirty', 'Private_Clean'):
                d[k] = int(v.split()[0]) / 1024
    except FileNotFoundError:
        pass
    return d


def healthy():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=1).read()
        return True
    except Exception:
        return False


def sample_for(pid, seconds, step=0.25):
    peak = 0
    end = time.time() + seconds
    while time.time() < end:
        peak = max(peak, status(pid).get('VmRSS', 0))
        time.sleep(step)
    return peak


def run(name):
    # Les exécutables compilés figent NODE_ENV=production au build : même valeur pour Node.
    env = dict(os.environ, PORT=str(PORT), NODE_ENV='production', ENABLE_RATE_LIMIT='false',
               VET_LOAD_DEFERRED='false', VET_LOAD_DELAY_MS='0',
               BDPM_CHECK_INTERVAL_HOURS='596', VET_CHECK_INTERVAL_HOURS='596',
               DATA_DIR=DATA_DIR, VET_DATA_DIR=VET_DATA_DIR)
    log = open(f'{OUT}/{name}.log', 'w')
    t0 = time.time()
    proc = subprocess.Popen(VARIANTS[name], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    pid = proc.pid
    peak_start = 0
    while not healthy():
        peak_start = max(peak_start, status(pid).get('VmRSS', 0))
        if proc.poll() is not None:
            raise RuntimeError(f'{name} terminé prématurément')
        time.sleep(0.1)
    ready_s = time.time() - t0
    res = {'name': name, 'ready_s': round(ready_s, 1)}

    peak_after = sample_for(pid, 20)
    res['startup_peak_rss'] = round(max(peak_start, peak_after), 1)
    res['hwm_after_startup'] = round(status(pid).get('VmHWM', 0), 1)
    res['idle_rss'] = round(status(pid).get('VmRSS', 0), 1)
    res['idle_rollup'] = {k: round(v, 1) for k, v in rollup(pid).items()}

    load = subprocess.Popen(['node', f'{ROOT}/scripts/benchmark/http-load.js', f'--base-url=http://127.0.0.1:{PORT}',
                             f'--paths={PATHS}', '--concurrency=8', '--duration=30', '--warmup=3', '--json'],
                            stdout=subprocess.PIPE, text=True)
    peak_load = 0
    while load.poll() is None:
        peak_load = max(peak_load, status(pid).get('VmRSS', 0))
        time.sleep(0.25)
    out = json.loads(load.stdout.read())
    res['load_rps'] = round(out['measured']['rps'])
    res['load_p50_ms'] = round(out['measured']['p50Ms'], 2)
    res['load_peak_rss'] = round(peak_load, 1)
    res['rss_end_of_load'] = round(status(pid).get('VmRSS', 0), 1)

    sample_for(pid, 25)
    res['rss_after_load_idle'] = round(status(pid).get('VmRSS', 0), 1)
    res['hwm_final'] = round(status(pid).get('VmHWM', 0), 1)
    res['final_status'] = {k: round(v, 1) for k, v in status(pid).items()}
    res['final_rollup'] = {k: round(v, 1) for k, v in rollup(pid).items()}

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    json.dump(res, open(f'{OUT}/{name}.json', 'w'), indent=1)
    print(json.dumps(res), flush=True)


for n in (sys.argv[1:] or [name for name, cmd in VARIANTS.items() if cmd[0]]):
    if not VARIANTS[n][0]:
        sys.exit(f'{n}: définir MEM_BIN_{n.upper().replace("-", "_")}')
    run(n)
    time.sleep(3)
