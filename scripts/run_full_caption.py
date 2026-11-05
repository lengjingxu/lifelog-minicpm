import os, subprocess, sys, time, fcntl

os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.environ.get("PATH", "")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = '/tmp/lifelog_full_caption.lock'
LOG = '/tmp/lifelog_full_caption.log'

def log(msg):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(time.strftime('%F %T ') + msg + chr(10))

fh = open(LOCK, 'w')
try:
    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    log('another instance running, exit')
    sys.exit(0)

os.chdir(ROOT)
py_bin = os.path.join(ROOT, '.venv', 'bin', 'python')
for attempt in range(1, 8):
    log('run attempt %d' % attempt)
    r = subprocess.run([py_bin, '-m', 'lifelog.cli', 'caption', '--model', 'minicpm-v-4.7-1b', '--concurrency', '4'],
                       capture_output=True, text=True)
    log('exit=%d out=%s err=%s' % (r.returncode, r.stdout.strip()[:400], r.stderr.strip()[-400:]))
    if r.returncode == 0 and '"todo": 0' in r.stdout.replace(' ', ''):
        log('done, no todo left')
        break
    time.sleep(30)
log('finished')
