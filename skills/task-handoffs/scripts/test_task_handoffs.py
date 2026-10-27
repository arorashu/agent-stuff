import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
HEAD = "a" * 40


def module(name):
    loader = importlib.machinery.SourceFileLoader(name, str(TOOLS / name))
    spec = importlib.util.spec_from_loader(name, loader)
    result = importlib.util.module_from_spec(spec)
    loader.exec_module(result)
    return result


class TaskHandoffs(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, TASK_STATUS_DIR=str(self.root))
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.status = module("task-status")
        self.watch = module("task-watch")
        identity = patch.object(self.watch, "process_identity", return_value="boot:123")
        identity.start()
        self.addCleanup(identity.stop)

    def test_explicit_queue_required_before_cli_work(self):
        commands = [
            ("task-status", "show"),
            ("task-status", "set", "sample-task", "--revision", "0", "--state", "running"),
            ("task-status", "claim", "sample-task", "--revision", "1", "--owner", "review"),
            ("task-status", "release", "sample-task", "--revision", "1", "--owner", "review"),
            ("task-watch", "--consumer", "review"),
            ("task-watch", "--pump", "--task", "sample-task"),
            ("task-watch", "--inspect-pane", "%987"),
        ]
        for value in (None, "", "relative-queue"):
            environment = dict(os.environ, HOME=str(self.root))
            environment.pop("TASK_STATUS_DIR", None)
            if value is not None:
                environment["TASK_STATUS_DIR"] = value
            for command in commands:
                with self.subTest(value=value, command=command):
                    result = subprocess.run(
                        [sys.executable, str(TOOLS / command[0]), *command[1:]],
                        env=environment, capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(result.returncode, 20)
                    self.assertIn("TASK_STATUS_DIR must be set to an absolute queue directory", result.stderr)
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertEqual(result.stdout, "")
            self.assertEqual(list(self.root.iterdir()), [])

    def ready(self):
        return self.status.update("sample-task", 0, "ready_for_review", {"head": HEAD, "report": "/tmp/report"})

    def test_atomic_record_and_explicit_ack(self):
        self.ready()
        self.assertEqual(len(self.watch.events("review")), 1)
        self.assertEqual(len(self.watch.events("review")), 1)
        self.watch.acknowledge("sample-task", 1, "review")
        self.assertEqual(self.watch.events("review"), [])
        self.assertFalse(list(self.root.glob(".tmp-*")))

    def test_same_second_updates_get_distinct_revisions(self):
        self.ready()
        self.watch.acknowledge("sample-task", 1, "review")
        record = self.status.update("sample-task", 1, "ready_for_review", {"report": "/tmp/new"})
        self.assertEqual(record["revision"], 2)
        self.assertEqual(len(self.watch.events("review")), 1)

    def test_compare_and_swap_rejects_stale_worker(self):
        self.ready()
        with self.assertRaisesRegex(ValueError, "Stale revision"):
            self.status.update("sample-task", 0, "running", {})
        self.assertEqual(self.status.load("sample-task")["state"], "ready_for_review")

    def test_approval_requires_exact_head_and_explicit_verdict(self):
        self.ready()
        with self.assertRaises(ValueError):
            self.status.update("sample-task", 1, "ready_for_security", {"reviewed_head": "b" * 40, "verdict": "approve", "report": "/tmp/review"})
        approved = self.status.update("sample-task", 1, "ready_for_security", {"reviewed_head": HEAD, "verdict": "approve", "report": "/tmp/review"})
        self.assertEqual(approved["reviewed_head"], HEAD)
        running = self.status.update("sample-task", 2, "running", {})
        self.assertNotIn("verdict", running)
        self.assertNotIn("reviewed_head", running)

    def test_new_head_clears_old_approval(self):
        self.ready()
        self.status.update("sample-task", 1, "ready_for_security", {"reviewed_head": HEAD, "verdict": "approve", "report": "/tmp/review"})
        ready = self.status.update("sample-task", 2, "ready_for_review", {"head": "b" * 40, "report": "/tmp/impl"})
        self.assertNotIn("verdict", ready)
        self.assertNotIn("reviewed_head", ready)

    def test_concurrent_claim_has_one_owner(self):
        self.ready()
        command = [sys.executable, str(TOOLS / "task-status"), "claim", "sample-task", "--revision", "1", "--owner"]
        processes = [subprocess.Popen(command + [owner], stdout=subprocess.PIPE, stderr=subprocess.PIPE) for owner in ("first", "second")]
        for process in processes:
            process.communicate(timeout=10)
        self.assertEqual(sorted(p.returncode for p in processes), [0, 20])

    def route(self):
        prompt = self.root / "review.md"
        prompt.write_text("Review only. Publish evidence for exact head.")
        return {"pane": "%987", "pane_pid": 123, "process_start": "boot:123", "prompt": str(prompt)}

    def test_transport_success_acks_only_after_enter(self):
        event = self.ready()
        calls = []

        def transport(*args, **kwargs):
            calls.append(args)
            if args[0] == "display-message":
                return "%987|123|pi\n"
            if args[0] == "capture-pane":
                return "idle"
            self.assertEqual(self.watch.seen("review"), {})
            return ""

        with patch.object(self.watch, "tmux", side_effect=transport):
            self.assertTrue(self.watch.dispatch(event, "review", self.route()))
        self.assertEqual(calls[-1], ("send-keys", "-t", "%987", "Enter"))
        self.assertEqual(self.watch.seen("review"), {"sample-task": 1})
        self.assertEqual(self.status.load("sample-task")["claim"]["owner"], "review")

    def test_uncertain_transport_is_not_acked_or_retried(self):
        event = self.ready()

        def transport(*args, **kwargs):
            if args[0] == "display-message":
                return "%987|123|pi\n"
            if args[0] == "capture-pane":
                return "idle"
            raise subprocess.TimeoutExpired(args, 10)

        with patch.object(self.watch, "tmux", side_effect=transport):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.watch.dispatch(event, "review", self.route())
            with self.assertRaisesRegex(ValueError, "already claimed"):
                self.watch.dispatch(event, "review", self.route())
        self.assertEqual(self.watch.seen("review"), {})

    def test_busy_or_replaced_pane_never_gets_prompt(self):
        event = self.ready()
        with patch.object(self.watch, "tmux", side_effect=["%987|999|pi\n"]):
            with self.assertRaisesRegex(ValueError, "process changed"):
                self.watch.dispatch(event, "review", self.route())
        with patch.object(self.watch, "tmux", side_effect=["%987|123|pi\n", "── Working ──"]):
            self.assertFalse(self.watch.dispatch(event, "review", self.route()))
        self.assertNotIn("claim", self.status.load("sample-task"))

    def test_restarted_process_same_pid_is_rejected(self):
        event = self.ready()
        for identities in (["boot:456"], ["boot:123", "boot:456"]):
            with (
                self.subTest(identities=identities),
                patch.object(self.watch, "tmux", side_effect=["%987|123|pi\n", "idle", "%987|123|pi\n"]),
                patch.object(self.watch, "process_identity", side_effect=identities),
            ):
                with self.assertRaisesRegex(ValueError, "process changed"):
                    self.watch.dispatch(event, "review", self.route())
            self.assertNotIn("claim", self.status.load("sample-task"))
        route = self.route()
        route.pop("process_start")
        with patch.object(self.watch, "tmux", return_value="%987|123|pi\n"):
            with self.assertRaisesRegex(ValueError, "process changed"):
                self.watch.dispatch(event, "review", route)
        self.assertNotIn("claim", self.status.load("sample-task"))

    @unittest.skipUnless(sys.platform == "linux", "Linux dispatch process guard")
    def test_persistent_shell_restarts_are_not_pi_ownership(self):
        watch = module("task-watch")
        standin = self.root / "pi"
        standin.symlink_to("/bin/sleep")
        shell = subprocess.Popen(
            ["bash", "-c", 'for i in 1 2; do "$1" 30 & echo $!; wait; done', "probe", str(standin)],
            stdout=subprocess.PIPE,
            text=True,
        )
        child = None
        try:
            for _ in range(2):
                child = int(shell.stdout.readline())
                with patch.object(watch, "tmux", return_value=f"%987|{shell.pid}|pi\n"):
                    with self.assertRaisesRegex(ValueError, "must own pane_pid"):
                        watch.inspect_pane("%987")
                os.kill(child, signal.SIGTERM)
                child = None
            shell.wait(timeout=5)
        finally:
            if child:
                os.kill(child, signal.SIGTERM)
            if shell.poll() is None:
                shell.terminate()
            shell.wait(timeout=5)
            shell.stdout.close()

    def test_operator_retry_clears_ack_and_claim(self):
        event = self.ready()

        def transport(*args, **kwargs):
            return "%987|123|pi\n" if args[0] == "display-message" else "idle" if args[0] == "capture-pane" else ""

        with patch.object(self.watch, "tmux", side_effect=transport):
            self.assertTrue(self.watch.dispatch(event, "review", self.route()))
            command = [sys.executable, str(TOOLS / "task-status"), "release", "sample-task", "--revision", "1", "--owner", "review"]
            self.assertEqual(self.watch.seen("review"), {"sample-task": 1})
            self.watch.acknowledge("sample-task", 1, "security")
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 20)
            self.assertIn("--retry-undelivered", result.stderr)
            self.assertIn("claim", self.status.load("sample-task"))
            self.assertEqual(self.watch.seen("review"), {"sample-task": 1})
            self.assertEqual(subprocess.run(command + ["--retry-undelivered"], capture_output=True, timeout=10).returncode, 0)
            self.assertNotIn("claim", self.status.load("sample-task"))
            self.assertEqual(self.watch.seen("review"), {})
            self.assertEqual(self.watch.seen("security"), {"sample-task": 1})
            self.assertTrue(self.watch.dispatch(event, "review", self.route()))
            self.assertEqual(self.watch.seen("review"), {"sample-task": 1})

    def test_interrupted_retry_retains_claim_after_clearing_ack(self):
        self.ready()
        self.status.claim("sample-task", 1, "review")
        self.watch.acknowledge("sample-task", 1, "review")
        atomic = self.status.atomic

        def interrupt(path, record):
            if path == self.status.path_for("sample-task"):
                self.assertEqual(self.watch.seen("review"), {})
                self.assertIn("claim", self.status.load("sample-task"))
                raise OSError("interrupted before claim removal")
            atomic(path, record)

        with patch.object(self.status, "atomic", side_effect=interrupt):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.status.release("sample-task", 1, "review", retry_undelivered=True)
        self.assertEqual(self.watch.seen("review"), {})
        self.assertIn("claim", self.status.load("sample-task"))
        with patch.object(self.watch, "tmux", side_effect=["%987|123|pi\n", "idle"]):
            with self.assertRaisesRegex(ValueError, "already claimed"):
                self.watch.dispatch(self.status.load("sample-task"), "review", self.route())

    def test_path_traversal_and_short_sha_rejected(self):
        for task in ("../oops", "UPPER", "x/y"):
            with self.assertRaises(ValueError):
                self.status.path_for(task)
        with self.assertRaises(ValueError):
            self.status.update("sample-task", 0, "ready_for_review", {"head": "abc", "report": "/tmp/report"})
        self.assertFalse((self.root / "sample-task.json").exists())

    def test_pump_waits_or_requests_assignment_without_agent_polling(self):
        command = [sys.executable, str(TOOLS / "task-watch"), "--pump", "--task", "sample-task"]
        self.assertEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 20)
        self.status.update("sample-task", 0, "running", {})
        self.assertEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 10)
        self.status.update("sample-task", 1, "ready_for_review", {"head": HEAD, "report": "/tmp/report"})
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["needs_assignment"], "review")
        self.status.update("sample-task", 2, "blocked", {"summary": "need user decision"})
        self.assertEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 0)

    def test_stale_claim_reaches_coordinator(self):
        self.ready()
        self.status.claim("sample-task", 1, "review")
        self.assertEqual(len(self.watch.events("coordinator", stale_seconds=0)), 1)

    def test_cli_pending_and_error_exit_codes(self):
        command = [sys.executable, str(TOOLS / "task-watch"), "--consumer", "review"]
        self.assertEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 10)
        self.ready()
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)[0]["head"], HEAD)


if __name__ == "__main__":
    unittest.main()
