"""Claude-led CLI delegation. Credentials stay in each provider's native store."""
from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / ".agent-team" / "runs"


def executable(provider):
    npm = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules"
    candidates = ([npm / "opencode-ai/bin/opencode.exe"] if provider == "glm" else
                  sorted((npm / "@openai/codex").rglob("codex.exe")))
    for path in candidates:
        if path.is_file():
            return str(path)
    name = "opencode" if provider == "glm" else "codex"
    path = shutil.which(name)
    if path and Path(path).suffix.lower() not in (".cmd", ".bat", ".ps1"):
        return path
    raise RuntimeError(f"Native {name} executable not found. Install its official CLI.")


def git(workspace, *args):
    return subprocess.check_output(["git", "-C", str(workspace), *args], text=True,
                                   encoding="utf-8", stderr=subprocess.PIPE).strip()


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def run_path(run_id):
    if not re.fullmatch(r"[a-z0-9-]+", run_id):
        raise RuntimeError("Invalid run ID")
    return RUNS / run_id


def summarize(folder, persist=False):
    metadata = json.loads((folder / "run.json").read_text(encoding="utf-8"))
    texts, usage, errors = [], [], []
    events = folder / "events.jsonl"
    if events.exists():
        for line in events.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            item, part = event.get("item", {}), event.get("part", {})
            if event.get("type") == "thread.started":
                metadata["session_id"] = event.get("thread_id")
            if event.get("sessionID"):
                metadata["session_id"] = event["sessionID"]
            if event.get("type") == "item.completed" and item.get("type") == "agent_message":
                texts.append(item.get("text", ""))
            if event.get("type") == "text":
                texts.append(part.get("text", ""))
            if event.get("usage"):
                usage.append(event["usage"])
            if event.get("type") == "step_finish":
                usage.append({"tokens": part.get("tokens"), "reported_cost": part.get("cost")})
            if event.get("type") in ("error", "turn.failed"):
                error = event.get("error", {})
                data = error.get("data", {}) if isinstance(error, dict) else {}
                errors.append({"type": event["type"], "name": error.get("name") if isinstance(error, dict) else None,
                               "message": data.get("message", str(error)), "status_code": data.get("statusCode")})
    metadata["usage"] = usage
    metadata["provider_errors"] = errors
    metadata["result"] = "\n\n".join(texts)
    if persist:
        (folder / "result.txt").write_text(metadata["result"], encoding="utf-8")
        save(folder / "run.json", metadata)
    return metadata


def stop(process):
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            result = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if result.returncode and process.poll() is None:
                return f"taskkill failed with exit {result.returncode}; child may still be running"
        else:
            process.terminate()
        process.wait(timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"Termination could not be confirmed: {error}"
    return None


def worker_command(args, workspace, env):
    requested_model = getattr(args, "model", None)
    effort = getattr(args, "reasoning", None) or ("max" if args.provider == "glm" else "medium")
    if args.provider == "codex":
        model = requested_model or "gpt-6-sol"
        if model not in ("gpt-6-sol", "gpt-6-astra"):
            raise RuntimeError("Codex workers may use only gpt-6-sol or gpt-6-astra")
        if effort not in ("low", "medium", "high", "xhigh", "max"):
            raise RuntimeError("Unsupported Codex reasoning effort")
        command = [executable("codex"), "exec", "--model", model, "-c",
                   f'model_reasoning_effort="{effort}"', "--json", "--color", "never", "--sandbox",
                   "read-only" if args.mode == "review" else "workspace-write", "-C", str(workspace), "-"]
    else:
        if requested_model:
            raise RuntimeError("GLM workers are fixed to glm-5.3; --model applies only to Codex")
        if effort not in ("low", "high", "max"):
            raise RuntimeError("GLM-5.3 reasoning must be low, high or max")
        model = "zai-coding-plan/glm-5.3"
        config = json.loads((ROOT / "opencode.json").read_text(encoding="utf-8"))
        config["provider"]["zai-coding-plan"]["models"]["glm-5.3"]["options"]["reasoningEffort"] = effort
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
        env["PWD"] = str(workspace)  # OpenCode resolves its project from PWD, not the process cwd
        command = [executable("glm"), "run", "--pure", "--dir", str(workspace), "--format", "json", "--model",
                   model, "--variant", effort, "--agent", "team-" + args.mode,
                   "Read the task packet supplied on standard input and complete only that task."]
    return command, model, effort


def dispatch(args):
    workspace = Path(args.workspace).resolve()
    git(workspace, "rev-parse", "--show-toplevel")
    common = Path(git(workspace, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    root_common = Path(git(ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    if common != root_common:
        raise RuntimeError("Worker workspace must belong to this repository")
    if args.mode == "build":
        registered = [Path(line[9:]).resolve() for line in git(ROOT, "worktree", "list", "--porcelain").splitlines()
                      if line.startswith("worktree ")]
        if not registered or workspace in (ROOT, registered[0]) or workspace not in registered:
            raise RuntimeError("Build workers require a separate registered worktree; preserve the primary checkout")
    task = Path(args.task_file).resolve().read_text(encoding="utf-8")
    if not task.strip():
        raise RuntimeError("Task packet is empty")
    task = ("You are a delegated development worker, not the team coordinator. "
            "Do not start other workers. Complete only the following task.\n\n" + task)
    env = os.environ.copy()
    command, model, reasoning = worker_command(args, workspace, env)
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
    folder = run_path(run_id)
    folder.mkdir(parents=True)
    packet = folder / "task.txt"
    packet.write_text(task, encoding="utf-8")
    metadata = {"id": run_id, "provider": args.provider, "mode": args.mode,
                "model": model, "reasoning": reasoning,
                "workspace": str(workspace), "head": git(workspace, "rev-parse", "HEAD"),
                "status": "running", "started": dt.datetime.now(dt.timezone.utc).isoformat()}
    save(folder / "run.json", metadata)
    print(f"Run: {run_id}\nEvidence: {folder}", flush=True)
    process = None
    try:
        with (folder / "events.jsonl").open("w", encoding="utf-8") as output, \
             (folder / "stderr.log").open("w", encoding="utf-8") as errors, \
             packet.open("r", encoding="utf-8") as input_packet:
            process = subprocess.Popen(command, cwd=workspace, env=env, stdin=input_packet,
                                       stdout=output, stderr=errors, text=True, encoding="utf-8",
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            while process.poll() is None:
                if (folder / "cancel.request").exists():
                    termination_error = stop(process)
                    metadata["status"] = "termination_failed" if termination_error else "cancelled"
                    if termination_error:
                        metadata["termination_error"] = termination_error
                    break
                time.sleep(0.25)
            metadata["exit_code"] = process.returncode
            if metadata["status"] == "running":
                metadata["status"] = "completed" if process.returncode == 0 else "failed"
            if metadata["status"] == "cancelled":
                metadata["exit_code"] = 130
            elif metadata["status"] == "termination_failed":
                metadata["exit_code"] = 1
    except KeyboardInterrupt:
        termination_error = stop(process) if process else None
        metadata["status"] = "termination_failed" if termination_error else "cancelled"
        metadata["exit_code"] = 1 if termination_error else 130
        if termination_error:
            metadata["termination_error"] = termination_error
    except Exception as error:
        if process:
            termination_error = stop(process)
            if termination_error:
                metadata["termination_error"] = termination_error
        metadata["status"] = "failed"
        metadata["error"] = str(error)
        metadata["exit_code"] = 1
    metadata["finished"] = dt.datetime.now(dt.timezone.utc).isoformat()
    save(folder / "run.json", metadata)
    result = summarize(folder, persist=True)
    if result["provider_errors"] and result["status"] not in ("cancelled", "termination_failed"):
        result["status"] = "failed"
        result["exit_code"] = result.get("exit_code") or 1
        save(folder / "run.json", result)
    print(json.dumps(result, indent=2))
    print((folder / "result.txt").read_text(encoding="utf-8"))
    return result.get("exit_code", 1) or (130 if result["status"] == "cancelled" else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    commands.add_parser("connect-zai", help="Enter the Z.ai platform API key privately on this computer")
    run = commands.add_parser("run")
    run.add_argument("provider", choices=["codex", "glm"])
    run.add_argument("--task-file", required=True)
    run.add_argument("--workspace", default=str(ROOT))
    run.add_argument("--mode", choices=["review", "build"], default="review")
    run.add_argument("--model", choices=["gpt-6-sol", "gpt-6-astra"], help="Codex model; default gpt-6-sol")
    run.add_argument("--reasoning", choices=["low", "medium", "high", "xhigh", "max"],
                     help="Codex: low/medium/high/xhigh/max; GLM: low/high/max")
    for name in ("status", "cancel"):
        sub = commands.add_parser(name)
        sub.add_argument("run_id")
    args = parser.parse_args()
    if args.command == "connect-zai":
        if not sys.stdin.isatty():
            raise RuntimeError("Run connect-zai in an interactive local terminal; never pipe a secret from chat")
        key = getpass.getpass("Z.ai platform API key (hidden; choose your Coding Plan key): ").strip()
        if not key or any(character.isspace() for character in key):
            raise RuntimeError("Key is empty or contains whitespace; credentials were not changed")
        auth_path = Path.home() / ".local/share/opencode/auth.json"
        auth_path.parent.mkdir(parents=True, exist_ok=True)
        credentials = json.loads(auth_path.read_text(encoding="utf-8")) if auth_path.exists() else {}
        credentials["zai-coding-plan"] = {"type": "api", "key": key}
        save(auth_path, credentials)
        print("Coding Plan credential saved locally; no key was logged. Run the GLM worker smoke test next.")
        return 0
    if args.command == "run":
        return dispatch(args)
    if args.command == "doctor":
        for provider in ("codex", "glm"):
            binary = executable(provider)
            print(f"{provider}: {binary}")
            subprocess.run([binary, "--version"], check=True)
        subprocess.run([executable("codex"), "login", "status"], check=True)
        subprocess.run([executable("glm"), "auth", "list"], check=True)
        subprocess.run([executable("glm"), "models", "zai-coding-plan"], check=True, cwd=ROOT)
        print("GLM: Coding Plan only, glm-5.3, low/high/max. Codex: gpt-6-sol or gpt-6-astra.")
        print("Doctor checks installation and stored credentials, not live provider connectivity.")
        return 0
    folder = run_path(args.run_id)
    if args.command == "cancel":
        metadata = json.loads((folder / "run.json").read_text(encoding="utf-8"))
        if metadata["status"] == "running":
            (folder / "cancel.request").touch()
        print("Cancellation requested" if metadata["status"] == "running" else "Run already finished")
    else:
        print(json.dumps(summarize(folder), indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Agent team: {error}", file=sys.stderr)
        sys.exit(1)
