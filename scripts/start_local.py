"""Start the local Trade app using only Python's standard library for setup."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'trade-paper-api'


def virtual_python(root):
    return root / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def prepare_environment(root):
    """Preserve local secrets; install only missing or changed runtime dependencies."""
    interpreter = virtual_python(root)
    if not interpreter.exists():
        print('Creating a project virtual environment…', flush=True)
        subprocess.run([sys.executable, '-m', 'venv', str(root / '.venv')], check=True)
    version = subprocess.run([str(interpreter), '-c', 'import sys; print(sys.version_info.major, sys.version_info.minor)'],
                             check=True, capture_output=True, text=True).stdout.split()
    if tuple(map(int, version)) < (3, 11):
        raise RuntimeError('The existing .venv uses an older Python. Rename it to .venv-old, install Python 3.11+, and launch again.')
    requirements = root / 'trading_app' / 'requirements.txt'
    fingerprint = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = root / '.venv' / '.trade-requirements.sha256'
    installed = marker.exists() and marker.read_text().strip() == fingerprint
    if installed:
        installed = subprocess.run([str(interpreter), '-c', 'import fastapi, uvicorn, dotenv, websockets'],
                                   capture_output=True).returncode == 0
    if not installed:
        print('Installing application dependencies. The first launch needs internet access…', flush=True)
        pip_env = dict(os.environ, PIP_DISABLE_PIP_VERSION_CHECK='1')
        subprocess.run([str(interpreter), '-m', 'pip', 'install', '-r', str(requirements)], check=True, env=pip_env)
        marker.write_text(fingerprint + '\n')
    try:
        descriptor = os.open(str(root / '.env'), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, 'w') as file:
            file.write((root / '.env.example').read_text())
        print('Created a private .env template. Public prices work without paper keys.', flush=True)
    return interpreter


def port_is_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.4):
            return True
    except OSError:
        return False


def trade_is_ready(url):
    try:
        with urlopen(url + '/api/health', timeout=1) as response:
            data = json.loads(response.read(65536))
        return data.get('service') == SERVICE and data.get('status') == 'ok'
    except (HTTPError, URLError, OSError, ValueError, AttributeError):
        return False


def stop_server(process):
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def wait_until_ready(process, url, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('The server stopped during startup. Check the messages above, including .env settings and port conflicts.')
        if trade_is_ready(url):
            return
        time.sleep(.2)
    raise RuntimeError('The server did not become ready. Check the startup messages and ensure ALLOWED_HOSTS includes 127.0.0.1.')


def open_dashboard(url, enabled):
    if not enabled:
        return
    try:
        opened = webbrowser.open(url)
    except webbrowser.Error:
        opened = False
    if not opened:
        print('Open this address in your browser: ' + url, flush=True)


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description='Prepare and run Trade locally; open the browser after the API is ready.')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--no-browser', action='store_true', help='Start without opening a browser.')
    args = parser.parse_args(argv)
    if sys.version_info < (3, 11):
        print('Trade needs Python 3.11 or newer. Install it from python.org, then run start.command again.', file=sys.stderr)
        return 1
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    url = 'http://127.0.0.1:' + str(args.port)
    process = None
    try:
        if port_is_open(args.port):
            if not trade_is_ready(url):
                raise RuntimeError(f'Port {args.port} is already in use. Stop the old server in its Terminal with Ctrl+C, or run ./start.command --port {args.port + 1 if args.port < 65535 else 8000}.')
            print('Trade is already running at ' + url + '. Opening the dashboard.', flush=True)
            print('After a code update, restart the existing server to load backend changes.', flush=True)
            open_dashboard(url, not args.no_browser)
            return 0
        interpreter = prepare_environment(root)
        print('\nStarting Trade at ' + url, flush=True)
        command = [str(interpreter), '-m', 'uvicorn', 'trading_app.api:app', '--host', '127.0.0.1',
                   '--port', str(args.port), '--no-proxy-headers', '--timeout-graceful-shutdown', '5']
        process = subprocess.Popen(command, cwd=str(root), start_new_session=True)
        wait_until_ready(process, url)
        print('\nReady: ' + url + '\nKeep this Terminal open. Press Ctrl+C to stop the app.\n', flush=True)
        open_dashboard(url, not args.no_browser)
        return process.wait()
    except KeyboardInterrupt:
        print('\nStopping Trade…', flush=True)
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('\nCould not start Trade: ' + str(error), file=sys.stderr)
        return 1
    finally:
        if process is not None:
            stop_server(process)


if __name__ == '__main__':
    raise SystemExit(main())
