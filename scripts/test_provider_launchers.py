"""Exercise Windows CMD launchers against a local executable, never the real CLI/browser."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def command_line(launcher: Path, flags: list[str]) -> str:
    command = subprocess.list2cmdline([str(launcher), *flags])
    # /s /c strips one outer quote pair, preserving the quoted batch path and its args.
    prefix = subprocess.list2cmdline([os.environ["COMSPEC"], "/d", "/s", "/c"])
    return prefix + ' "' + command + '"'


def main() -> None:
    project = (
        Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    )
    workspace = project / "work"
    created_workspace = not workspace.exists()
    workspace.mkdir(exist_ok=True)
    temporary = tempfile.TemporaryDirectory(prefix="launcher-test-", dir=workspace)
    scratch = Path(temporary.name).resolve()
    if not scratch.is_relative_to(workspace.resolve()):
        raise RuntimeError("Unsafe launcher test directory")
    try:
        mock_project = scratch / "mock project with spaces"
        launchers = mock_project / "launchers"
        launchers.mkdir(parents=True)
        executable = mock_project / ".venv" / "Scripts" / "python.exe"
        executable.parent.mkdir(parents=True)
        for provider in ("deepseek", "qwen", "kimi", "perplexity"):
            shutil.copyfile(
                project / "launchers" / f"open-{provider}.cmd", launchers / f"open-{provider}.cmd"
            )
        source = scratch / "MockCli.cs"
        source.write_text(
            "using System; using System.IO; using System.Web.Script.Serialization; "
            "class MockCli { static int Main(string[] args) { "
            'File.WriteAllText(Environment.GetEnvironmentVariable("MCA_TEST_ARGV"), '
            "new JavaScriptSerializer().Serialize(args)); "
            'Console.WriteLine("LOCAL_MOCK_CLI_ONLY"); '
            'return int.Parse(Environment.GetEnvironmentVariable("MCA_TEST_EXIT")); } }',
            encoding="utf-8",
        )
        compiler_paths = [
            Path(os.environ["WINDIR"]) / "Microsoft.NET" / framework / "v4.0.30319" / "csc.exe"
            for framework in ("Framework64", "Framework")
        ]
        compiler = next((path for path in compiler_paths if path.exists()), None)
        if compiler is None:
            raise RuntimeError(".NET Framework C# compiler required for the offline launcher test")
        subprocess.run(
            [
                str(compiler),
                "/nologo",
                "/target:exe",
                "/reference:System.Web.Extensions.dll",
                f"/out:{executable}",
                str(source),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        log = scratch / "arguments.json"
        environment = os.environ.copy()
        environment.update(MCA_TEST_ARGV=str(log), MCA_TEST_EXIT="0")
        settings = [
            [],
            ["--think", "on", "--search", "off", "--mode", "think=on", "--mode", "search=off"],
            ["--mode", "custom=two words", "--wait-timeout", "12"],
        ]
        for provider in ("deepseek", "qwen", "kimi", "perplexity"):
            for flags in settings:
                result = subprocess.run(
                    command_line(launchers / f"open-{provider}.cmd", flags),
                    cwd=scratch,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                assert result.returncode == 0, (result.stdout, result.stderr)
                actual = json.loads(log.read_text(encoding="utf-8-sig"))
                assert actual == ["-m", "multi_chat_agent", "open", provider, "--wait", *flags], (
                    actual
                )
        print(
            "PASS CMD launchers: fixed providers, open/--wait, "
            "omitted and explicit modes, spaced values"
        )

        # Keep stdin open, as Explorer's console would. A failure must wait for a key.
        log.unlink()
        environment["MCA_TEST_EXIT"] = "7"
        process = subprocess.Popen(
            command_line(launchers / "open-qwen.cmd", []),
            cwd=scratch,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not log.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert log.exists(), "Mock CLI did not run"
            try:
                process.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                pass
            else:
                raise AssertionError("Launcher disappeared after an error instead of pausing")
            output, errors = process.communicate(input="\n", timeout=10)
            assert process.returncode == 7, (output, errors)
            assert "Opening Qwen did not complete" in output
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
        print("PASS CMD launchers: error remains visible until input, original exit code preserved")

        absent_project = scratch / "missing environment"
        absent_launchers = absent_project / "launchers"
        absent_launchers.mkdir(parents=True)
        shutil.copyfile(launchers / "open-deepseek.cmd", absent_launchers / "open-deepseek.cmd")
        missing = subprocess.run(
            command_line(absent_launchers / "open-deepseek.cmd", []),
            cwd=scratch,
            env=environment,
            input="\n",
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert missing.returncode == 2, (missing.stdout, missing.stderr)
        assert "bootstrap.ps1" in missing.stdout
        print("PASS CMD launchers: missing environment gives an actionable error")
    finally:
        # Verify the exact absolute target before TemporaryDirectory recursively removes it.
        if not scratch.is_relative_to(workspace.resolve()):
            raise RuntimeError("Unsafe launcher test cleanup")
        temporary.cleanup()
        if created_workspace and not any(workspace.iterdir()):
            workspace.rmdir()


if __name__ == "__main__":
    main()
