import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import signal
import subprocess

import pytest
from scripts import start_local as launcher


@pytest.fixture
def project(tmp_path):
    root = tmp_path / 'Trade Workspace'
    (root / 'trading_app').mkdir(parents=True)
    (root / 'trading_app/requirements.txt').write_text('fastapi==0.121.1\n')
    (root / '.env.example').write_text('PUBLIC_MARKET_DATA=true\n')
    return root


def setup_runner(monkeypatch, root, version='3 12\n'):
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        if args[1:3] == ['-m', 'venv']:
            interpreter = launcher.virtual_python(root)
            interpreter.parent.mkdir(parents=True, exist_ok=True)
            interpreter.write_text('test interpreter')
        return SimpleNamespace(stdout=version, returncode=0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    return calls


def test_first_launch_installs_in_project_venv_and_creates_private_env(project, monkeypatch):
    calls = setup_runner(monkeypatch, project)
    python = launcher.prepare_environment(project)
    assert python == launcher.virtual_python(project)
    pip = next(call for call in calls if call[0][1:4] == ['-m', 'pip', 'install'])
    assert pip[0][-1] == str(project / 'trading_app/requirements.txt')
    assert pip[1]['env']['PIP_DISABLE_PIP_VERSION_CHECK'] == '1'
    assert (project / '.env').read_text() == 'PUBLIC_MARKET_DATA=true\n'
    assert (project / '.env').stat().st_mode & 0o777 == 0o600
    assert (project / '.venv/.trade-requirements.sha256').exists()


def test_repeat_launch_preserves_secrets_and_skips_unchanged_installs(project, monkeypatch, capsys):
    calls = setup_runner(monkeypatch, project)
    launcher.prepare_environment(project)
    (project / '.env').write_text('PRIVATE_TEST_VALUE_DO_NOT_PRINT\n')
    calls.clear()
    launcher.prepare_environment(project)
    assert not any(call[0][1:4] == ['-m', 'pip', 'install'] for call in calls)
    assert (project / '.env').read_text() == 'PRIVATE_TEST_VALUE_DO_NOT_PRINT\n'
    assert 'PRIVATE_TEST_VALUE' not in capsys.readouterr().out
    (project / 'trading_app/requirements.txt').write_text('changed dependency input\n')
    calls.clear()
    launcher.prepare_environment(project)
    assert any(call[0][1:4] == ['-m', 'pip', 'install'] for call in calls)


def test_old_virtualenv_is_reported_without_deleting_it(project, monkeypatch):
    setup_runner(monkeypatch, project, version='3 9\n')
    with pytest.raises(RuntimeError, match='Rename it'):
        launcher.prepare_environment(project)
    assert launcher.virtual_python(project).exists()


class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return self.data


def test_server_identity_check_rejects_other_apps_and_malformed_responses(monkeypatch):
    for data, expected in [(b'{"service":"trade-paper-api","status":"ok"}', True), (b'{"status":"ok"}', False), (b'HTML', False), (b'[]', False)]:
        monkeypatch.setattr(launcher, 'urlopen', lambda *args, **kwargs: Response(data))
        assert launcher.trade_is_ready('http://127.0.0.1:8000') is expected
    def offline(*args, **kwargs): raise OSError('offline')
    monkeypatch.setattr(launcher, 'urlopen', offline)
    assert not launcher.trade_is_ready('http://127.0.0.1:8000')


def test_existing_trade_server_opens_without_installing_or_spawning(project, monkeypatch):
    monkeypatch.setattr(launcher, 'port_is_open', lambda port: True)
    monkeypatch.setattr(launcher, 'trade_is_ready', lambda url: True)
    prepare = Mock(side_effect=AssertionError('must not install'))
    monkeypatch.setattr(launcher, 'prepare_environment', prepare)
    browser = Mock(return_value=True)
    monkeypatch.setattr(launcher.webbrowser, 'open', browser)
    assert launcher.main(['--port', '8001'], root=project) == 0
    browser.assert_called_once_with('http://127.0.0.1:8001')


def test_unrelated_port_conflict_is_not_killed(project, monkeypatch, capsys):
    monkeypatch.setattr(launcher, 'port_is_open', lambda port: True)
    monkeypatch.setattr(launcher, 'trade_is_ready', lambda url: False)
    process = Mock(side_effect=AssertionError('must not spawn'))
    monkeypatch.setattr(launcher.subprocess, 'Popen', process)
    assert launcher.main([], root=project) == 1
    assert '--port 8001' in capsys.readouterr().err


def test_launch_waits_for_health_before_opening_browser_and_uses_project_cwd(project, monkeypatch):
    steps = []
    monkeypatch.setattr(launcher, 'port_is_open', lambda port: False)
    monkeypatch.setattr(launcher, 'prepare_environment', lambda root: launcher.virtual_python(root))
    process = SimpleNamespace(wait=lambda: steps.append('wait') or 0, poll=lambda: 0)
    def spawn(command, **kwargs):
        steps.append('spawn')
        assert command[0] == str(launcher.virtual_python(project))
        assert kwargs['cwd'] == str(project) and kwargs['start_new_session']
        assert '--no-proxy-headers' in command and '--timeout-graceful-shutdown' in command
        return process
    monkeypatch.setattr(launcher.subprocess, 'Popen', spawn)
    monkeypatch.setattr(launcher, 'wait_until_ready', lambda *args: steps.append('ready'))
    monkeypatch.setattr(launcher.webbrowser, 'open', lambda url: steps.append('browser') or True)
    assert launcher.main([], root=project) == 0
    assert steps == ['spawn', 'ready', 'browser', 'wait']


def test_ctrl_c_stops_only_the_launched_process(project, monkeypatch):
    monkeypatch.setattr(launcher, 'port_is_open', lambda port: False)
    monkeypatch.setattr(launcher, 'prepare_environment', lambda root: launcher.virtual_python(root))
    signals = []
    class Process:
        def poll(self): return None
        def send_signal(self, value): signals.append(value)
        def wait(self, timeout=None):
            if timeout is None: raise KeyboardInterrupt
            return 0
    monkeypatch.setattr(launcher.subprocess, 'Popen', lambda *args, **kwargs: Process())
    monkeypatch.setattr(launcher, 'wait_until_ready', lambda *args: None)
    assert launcher.main(['--no-browser'], root=project) == 0
    assert signals == [signal.SIGINT]


def test_startup_failure_cleans_up_child_and_reports_error(project, monkeypatch, capsys):
    monkeypatch.setattr(launcher, 'port_is_open', lambda port: False)
    monkeypatch.setattr(launcher, 'prepare_environment', lambda root: launcher.virtual_python(root))
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(launcher.subprocess, 'Popen', lambda *args, **kwargs: process)
    monkeypatch.setattr(launcher, 'wait_until_ready', Mock(side_effect=RuntimeError('startup failed')))
    assert launcher.main(['--no-browser'], root=project) == 1
    process.send_signal.assert_called_once_with(signal.SIGINT)
    assert 'startup failed' in capsys.readouterr().err


def test_readiness_wait_detects_early_exit_or_success(monkeypatch):
    with pytest.raises(RuntimeError, match='stopped during startup'):
        launcher.wait_until_ready(SimpleNamespace(poll=lambda: 1), 'http://127.0.0.1:8000')
    monkeypatch.setattr(launcher, 'trade_is_ready', lambda url: True)
    launcher.wait_until_ready(SimpleNamespace(poll=lambda: None), 'http://127.0.0.1:8000')
    with pytest.raises(RuntimeError, match='did not become ready'):
        launcher.wait_until_ready(SimpleNamespace(poll=lambda: None), 'http://127.0.0.1:8000', timeout=0)


def test_owned_process_shutdown_has_bounded_waits():
    process = Mock()
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired('owned-server', 10), subprocess.TimeoutExpired('owned-server', 3), 0]
    launcher.stop_server(process)
    process.terminate.assert_called_once()
    process.kill.assert_called_once()


def test_browser_failure_keeps_manual_url_available(monkeypatch, capsys):
    monkeypatch.setattr(launcher.webbrowser, 'open', Mock(side_effect=launcher.webbrowser.Error('no browser')))
    launcher.open_dashboard('http://127.0.0.1:8000', True)
    assert 'http://127.0.0.1:8000' in capsys.readouterr().out
