"""Behavior checks for the local launcher; these do not simulate provider success."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import agent_team


class LauncherTests(unittest.TestCase):
    def test_codex_model_and_reasoning_are_explicit(self):
        args = argparse.Namespace(provider="codex", mode="review", model="gpt-6-astra", reasoning="xhigh")
        with mock.patch.object(agent_team, "executable", return_value="codex.exe"):
            command, model, effort = agent_team.worker_command(args, agent_team.ROOT, {})
        self.assertEqual((model, effort), ("gpt-6-astra", "xhigh"))
        self.assertEqual(command[command.index("--model") + 1], model)
        self.assertIn('model_reasoning_effort="xhigh"', command)
        args.model = "another-model"
        with self.assertRaises(RuntimeError):
            agent_team.worker_command(args, agent_team.ROOT, {})

    def test_glm_effort_overrides_config_without_changing_source(self):
        original = (agent_team.ROOT / "opencode.json").read_bytes()
        for effort in ("low", "high", "max"):
            args = argparse.Namespace(provider="glm", mode="review", model=None, reasoning=effort)
            env = {}
            with mock.patch.object(agent_team, "executable", return_value="opencode.exe"):
                command, model, selected = agent_team.worker_command(args, agent_team.ROOT, env)
            self.assertEqual(model, "zai-coding-plan/glm-5.3")
            self.assertEqual(selected, effort)
            self.assertEqual(command[command.index("--variant") + 1], effort)
            config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
            self.assertEqual(config["provider"]["zai-coding-plan"]["models"]["glm-5.3"]["options"]["reasoningEffort"], effort)
        self.assertEqual((agent_team.ROOT / "opencode.json").read_bytes(), original)
        for effort in ("medium", "xhigh"):
            args.reasoning = effort
            with self.assertRaises(RuntimeError):
                agent_team.worker_command(args, agent_team.ROOT, {})

    def test_primary_checkout_cannot_be_a_build_target(self):
        args = argparse.Namespace(workspace=str(agent_team.ROOT), mode="build")
        with self.assertRaisesRegex(RuntimeError, "separate registered worktree"):
            agent_team.dispatch(args)

    def test_run_id_cannot_escape_evidence_directory(self):
        for value in ("../credentials", "C:\\outside", "a/b", ""):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                agent_team.run_path(value)

    def test_status_does_not_overwrite_running_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            original = '{"status":"running"}'
            (folder / "run.json").write_text(original, encoding="utf-8")
            event = {"type": "error", "error": {"name": "APIError", "data": {
                "message": "invalid token", "statusCode": 401,
                "responseHeaders": {"set-cookie": "private-cookie"}}}}
            (folder / "events.jsonl").write_text(json.dumps(event), encoding="utf-8")
            result = agent_team.summarize(folder)
            self.assertEqual((folder / "run.json").read_text(encoding="utf-8"), original)
            self.assertNotIn("private-cookie", json.dumps(result))
            self.assertEqual(result["provider_errors"][0]["status_code"], 401)

    def exercise_process(self, child_code, cancel=False):
        with tempfile.TemporaryDirectory() as directory:
            runs = Path(directory) / "runs"
            packet = Path(directory) / "packet.txt"
            packet.write_text("Local process harness only", encoding="utf-8")
            args = argparse.Namespace(workspace=str(agent_team.ROOT), mode="review",
                                      task_file=str(packet), provider="codex", model=None)
            real_popen = subprocess.Popen
            def harness(command, **kwargs):
                if Path(command[0]).name.lower() != "codex.exe":
                    return real_popen(command, **kwargs)
                return real_popen([sys.executable, "-c", child_code], **kwargs)
            watcher = None
            if cancel:
                def request_cancel():
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        folders = list(runs.glob("*"))
                        if folders and (folders[0] / "run.json").exists():
                            (folders[0] / "cancel.request").touch()
                            return
                        time.sleep(0.05)
                watcher = threading.Thread(target=request_cancel)
                watcher.start()
            with mock.patch.object(agent_team, "RUNS", runs), \
                 mock.patch.object(agent_team.subprocess, "Popen", side_effect=harness), \
                 contextlib.redirect_stdout(io.StringIO()):
                code = agent_team.dispatch(args)
            if watcher:
                watcher.join(timeout=12)
            folder = next(runs.iterdir())
            return code, json.loads((folder / "run.json").read_text(encoding="utf-8"))

    def test_zero_exit_with_provider_error_is_still_failure(self):
        code, result = self.exercise_process(
            'import sys,json;sys.stdin.read();print(json.dumps({"type":"error","error":{"message":"failed"}}))')
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "failed")

    def test_cancel_request_terminates_running_child(self):
        code, result = self.exercise_process('import sys,time;sys.stdin.read();time.sleep(30)', cancel=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(result["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
