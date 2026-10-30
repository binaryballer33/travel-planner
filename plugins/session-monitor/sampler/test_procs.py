"""Unit tests for the Ports tab's helper: run with
/usr/bin/python3 -m unittest discover -s sampler -v   (from the mod folder)

Nothing here signals or starts a real process: the machine is a FakeSystem.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from typing import Dict, Iterable, List, Set, Tuple

from procs import (
    IS_WINDOWS,
    SIGNALS,
    Context,
    Listener,
    Row,
    System,
    base_name,
    build_snapshot,
    group_is_safe,
    is_abs,
    is_claude,
    is_monitor,
    launch_argv,
    launch_env,
    main,
    parse_cwds,
    parse_etime,
    parse_listeners,
    parse_netstat_listeners,
    parse_ps,
    plan_stop,
    protected_pids,
    read_tail,
    redact,
    refusal,
    run_launch,
    run_stop,
    send_signal,
    session_roots,
    short_name,
    this_session,
)

NOW = 1_760_000_000_000
#: What launch_argv puts before the command: the shell that runs it.
WORKS_UNDER = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c"] if IS_WINDOWS else ["/bin/sh", "-c"]
HERE = "/Users/me/.claude/mods/session-monitor/sampler"
CLAUDE = "/Users/me/Library/Application Support/Claude/claude-code/2.1.293/abc/claude.app/Contents/MacOS/claude"
UID = 501

PS_STATS = "\n".join(
    [
        "    1     0     1     0 Ss   10-00:00:00   0.0  12000 /sbin/launchd",
        f"  100     1   100   {UID} S    01:00:00   1.0   2000 /Applications/Claude.app/Contents/Helpers/disclaimer",
        f"  101   100   100   {UID} S    01:00:00  12.5 400000 {CLAUDE}",
        f"  102   101   100   {UID} S    59:00   0.0  40000 npm exec @gitkraken/gk mcp --plugin --host=claude",
        f"  103   101   100   {UID} S    10:00   0.4  20000 /Library/Developer/CommandLineTools/usr/bin/python3",
        f"  104   101   104   {UID} S    00:30   0.0   3000 /bin/zsh",
        f"  105   104   104   {UID} T    00:20   0.0   5000 /usr/bin/python3",
        f"  106   101   106   {UID} S    00:05   0.0   2000 /Library/Developer/CommandLineTools/usr/bin/python3",
        f"  107   106   106   {UID} R    00:01   0.0   1000 ps",
        f"  200     1   200   {UID} S    02-03:00:00   0.1 300000 {CLAUDE}",
        f"  201   200   200   {UID} S    02-02:59:00   0.0  30000 /usr/local/bin/node",
        f"  300     1   300   {UID} Ss   05:00   0.0   1000 /bin/sh",
        f"  301   300   300   {UID} S    05:00   0.1  30000 /opt/homebrew/bin/task",
        f"  302   301   300   {UID} S    04:59   2.0 150000 /Users/me/.bun/bin/bun",
        f"  400     1   400     0 Ss   20:00   0.0   8000 /usr/sbin/sshd",
        f"  500     1   500   {UID} S    30:00   0.3  90000 /Applications/Beeper Desktop.app/Contents/MacOS/Beeper Desktop",
    ]
)
PS_COMMANDS = "\n".join(
    [
        "    1 /sbin/launchd",
        "  100 /Applications/Claude.app/Contents/Helpers/disclaimer",
        f"  101 {CLAUDE} --output-format stream-json --verbose",
        "  102 npm exec @gitkraken/gk mcp --plugin --host=claude",
        f"  103 /Library/Developer/CommandLineTools/usr/bin/python3 -I {HERE}/sampler.py",
        "  104 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && "
        "eval 'python3 serve.py --port 9000 API_TOKEN=abc123' < /dev/null && pwd -P >| /tmp/claude-1-cwd",
        "  105 /usr/bin/python3 serve.py --port 9000",
        f"  106 /Library/Developer/CommandLineTools/usr/bin/python3 -I {HERE}/procs.py snapshot",
        "  107 ps -A -ww -o pid=,command=",
        f"  200 {CLAUDE}",
        "  201 /usr/local/bin/node /Users/me/mcp/server.js --api-key sk-ant-REALLYSECRET1234567890 --port 7000",
        "  300 /bin/sh -c task dev",
        "  301 /opt/homebrew/bin/task dev",
        "  302 /Users/me/.bun/bin/bun run dev",
        "  400 /usr/sbin/sshd -D",
        "  500 /Applications/Beeper Desktop.app/Contents/MacOS/Beeper Desktop",
    ]
)
LSOF = "\n".join(
    [
        "p201",
        "cnode",
        f"u{UID}",
        "f20",
        "n127.0.0.1:7000",
        "f21",
        "n[::1]:7000",
        "p302",
        "cbun",
        f"u{UID}",
        "f30",
        "n*:8133",
        "f31",
        "n*:8133",
        "p105",
        "cPython",
        f"u{UID}",
        "f3",
        "n127.0.0.1:9000",
        "p500",
        "cBeeper Desktop",
        f"u{UID}",
        "f9",
        "n127.0.0.1:23373",
        "p400",
        "csshd",
        "u0",
        "f3",
        "n*:22",
    ]
)


def rows() -> Dict[int, Row]:
    return parse_ps(PS_STATS, PS_COMMANDS, NOW)


def ctx() -> Context:
    return Context(me=106, uid=UID, here=HERE)


class FakeSystem(System):
    """The machine in memory: ps rows, listeners, and every signal recorded."""

    def __init__(self, table: Dict[int, Row], listeners: List[Listener]) -> None:
        self.table = dict(table)
        self.ports = list(listeners)
        self.clock = NOW
        self.signals: List[Tuple[str, int, int]] = []
        self.spawned: List[Tuple[List[str], str, Dict[str, str]]] = []
        #: Processes that ignore SIGTERM (only SIGKILL ends them).
        self.stubborn: Set[int] = set()

    def now_ms(self) -> int:
        return self.clock

    def ps(self) -> Dict[int, Row]:
        return dict(self.table)

    def listeners(self) -> List[Listener]:
        return [one for one in self.ports if one.pid in self.table]

    def cwds(self, pids: Iterable[int]) -> Dict[int, str]:
        return {pid: "/Users/me/project" for pid in pids}

    def _end(self, pids: List[int], sig: int) -> None:
        for pid in pids:
            if sig == SIGNALS["KILL"] or (sig == SIGNALS["TERM"] and pid not in self.stubborn):
                self.table.pop(pid, None)

    def kill(self, pid: int, sig: int) -> None:
        if pid not in self.table:
            raise ProcessLookupError(pid)
        self.signals.append(("kill", pid, sig))
        self._end([pid], sig)

    def killpg(self, pgid: int, sig: int) -> None:
        members = [pid for pid, row in self.table.items() if row.pgid == pgid]
        if not members:
            raise ProcessLookupError(pgid)
        self.signals.append(("killpg", pgid, sig))
        self._end(members, sig)

    def sleep(self, seconds: float) -> None:
        self.clock += int(seconds * 1000)

    def spawn(self, argv: List[str], cwd: str, env: Dict[str, str], log_fd: int) -> int:
        self.spawned.append((argv, cwd, env))
        os.write(log_fd, b"server output\n")
        return 4242


class ReusingSystem(FakeSystem):
    """After 4 s, pid 201 has exited and the pid belongs to another program."""

    def sleep(self, seconds: float) -> None:
        super().sleep(seconds)
        if self.clock - NOW >= 4_000 and self.table[201].exe != "/bin/other":
            self.table[201] = Row(pid=201, ppid=1, pgid=201, uid=UID, stat="S", started_ms=self.clock, cpu_pct=0.0, mem_bytes=0, exe="/bin/other", args="")
            self.ports = [one for one in self.ports if one.pid != 201]


class Parsing(unittest.TestCase):
    def test_etime(self) -> None:
        self.assertEqual(parse_etime("00:05"), 5)
        self.assertEqual(parse_etime("01:00:00"), 3600)
        self.assertEqual(parse_etime("02-03:00:00"), 2 * 86400 + 3 * 3600)
        self.assertIsNone(parse_etime("bogus"))
        self.assertIsNone(parse_etime("1:2:3:4"))

    def test_ps_rows_keep_paths_with_spaces_and_split_args(self) -> None:
        table = rows()
        claude = table[101]
        self.assertEqual(claude.exe, CLAUDE)
        self.assertEqual(claude.args, "--output-format stream-json --verbose")
        self.assertEqual(claude.started_ms, NOW - 3600 * 1000)
        self.assertEqual(claude.mem_bytes, 400000 * 1024)
        self.assertAlmostEqual(claude.cpu_pct, 12.5)
        self.assertEqual(table[105].state, "suspended")
        self.assertEqual(table[104].state, "running")
        # A retitled node process: argv[0] is the whole title, no args left.
        self.assertEqual(table[102].args, "")

    def test_listeners_merge_addresses_per_process_and_port(self) -> None:
        found = parse_listeners(LSOF)
        self.assertEqual([(one.port, one.pid) for one in found], [(22, 400), (7000, 201), (8133, 302), (9000, 105), (23373, 500)])
        node = [one for one in found if one.pid == 201][0]
        self.assertEqual(node.address, "127.0.0.1 [::1]")
        self.assertEqual([one for one in found if one.pid == 302][0].address, "*")
        self.assertEqual([one for one in found if one.pid == 400][0].uid, 0)

    def test_cwds(self) -> None:
        self.assertEqual(parse_cwds("p101\nfcwd\nn/Users/me/a b\np200\nfcwd\nn/tmp\n"), {101: "/Users/me/a b", 200: "/tmp"})


class Names(unittest.TestCase):
    def test_redact_masks_credentials(self) -> None:
        self.assertEqual(redact("API_TOKEN=abc123 x"), "API_TOKEN=*** x")
        self.assertEqual(redact("curl -H Authorization: Bearer abc.def"), "curl -H Authorization: Bearer ***")
        self.assertEqual(redact("git clone https://me:pw@github.com/x"), "git clone https://***@github.com/x")

    def test_short_names_never_carry_secrets(self) -> None:
        table = rows()
        self.assertEqual(short_name(table[201].exe, table[201].args), "node server.js 7000")
        self.assertNotIn("sk-ant", short_name(table[201].exe, table[201].args))
        self.assertEqual(short_name(table[102].exe, table[102].args), "npm exec @gitkraken/gk mcp")
        self.assertEqual(short_name("/usr/bin/python3", "-m http.server 8000"), "python3 http.server 8000")
        self.assertEqual(short_name("/usr/bin/python3", "-c import os; print(os.environ)"), "python3 os; print(os.environ)")
        self.assertEqual(short_name("/usr/bin/tool", "--token abcdef run"), "tool run")
        self.assertEqual(short_name("/usr/bin/tool", "ghp_abcdefghijklmnopqrstuvwxyz0123456789 run"), "tool run")
        self.assertEqual(short_name("/usr/bin/curl", "https://me:pw@example.com/x?token=1"), "curl https://example.com/x")

    def test_a_bash_tool_shell_is_named_by_its_command_redacted(self) -> None:
        table = rows()
        self.assertEqual(short_name(table[104].exe, table[104].args), "$ python3 serve.py --port 9000 API_TOKEN=***")

    def test_claude_and_monitor_detection(self) -> None:
        table = rows()
        self.assertTrue(is_claude(table[101]))
        self.assertTrue(is_claude(table[200]))
        self.assertFalse(is_claude(table[100]))  # the desktop app's disclaimer helper
        self.assertFalse(is_claude(table[500]))
        self.assertTrue(is_monitor(table[103], HERE))
        self.assertTrue(is_monitor(table[106], HERE))
        self.assertFalse(is_monitor(table[105], HERE))
        cached = Row(pid=9, ppid=8, pgid=9, uid=UID, stat="S", started_ms=NOW, cpu_pct=0.0, mem_bytes=0, exe="/usr/bin/python3",
                     args="-I /Users/me/.claude/plugins/cache/local-mods/session-monitor/0.1.0/sampler/sampler.py")
        self.assertTrue(is_monitor(cached, HERE))


class Tree(unittest.TestCase):
    def test_sessions_and_this_session(self) -> None:
        table = rows()
        self.assertEqual(session_roots(table), [101, 200])
        self.assertEqual(this_session(table, 106), 101)

    def test_snapshot_shape(self) -> None:
        table = rows()
        snap = build_snapshot(table, parse_listeners(LSOF), {101: "/Users/me/repo", 302: "/Users/me/project"}, [8133, 8134], ctx(), NOW, {8133: ["ready"]}, [300, 999])
        sessions = snap["sessions"]
        assert isinstance(sessions, list)
        self.assertEqual([one["pid"] for one in sessions], [101, 200])
        this = sessions[0]
        self.assertTrue(this["isThis"])
        self.assertEqual(this["cwd"], "/Users/me/repo")
        self.assertEqual(this["name"], "Claude Code")
        children = this["children"]
        assert isinstance(children, list)
        # This helper (106) and its ps (107) are left out; the sampler is marked.
        self.assertEqual([(one["pid"], one["depth"]) for one in children], [(102, 1), (103, 1), (104, 1), (105, 2)])
        self.assertTrue([one for one in children if one["pid"] == 103][0]["isMonitor"])
        suspended = [one for one in children if one["pid"] == 105][0]
        self.assertEqual(suspended["state"], "suspended")
        self.assertEqual(suspended["ports"], [9000])
        other = sessions[1]
        self.assertFalse(other["isThis"])
        listeners = snap["listeners"]
        assert isinstance(listeners, list)
        owners = {one["port"]: (one["owner"], one.get("sessionPid")) for one in listeners}
        self.assertEqual(owners[7000], ("claude", 200))
        self.assertEqual(owners[9000], ("claude", 101))
        self.assertEqual(owners[8133], ("dev", None))
        self.assertEqual(owners[23373], ("other", None))
        self.assertEqual([one for one in listeners if one["port"] == 23373][0]["name"], "Beeper Desktop")
        dev = snap["devServers"]
        assert isinstance(dev, list)
        self.assertEqual(len(dev), 1)
        server = dev[0]
        self.assertEqual(server["port"], 8133)
        self.assertEqual(server["pgid"], 300)
        self.assertTrue(server["isGroupSafe"])
        self.assertEqual(server["procs"], 3)
        self.assertEqual(server["memBytes"], (1000 + 30000 + 150000) * 1024)
        self.assertEqual(server["startedAt"], NOW - 300 * 1000)
        self.assertEqual(server["cwd"], "/Users/me/project")
        self.assertEqual(snap["logs"], [{"port": 8133, "lines": ["ready"]}])
        self.assertEqual(snap["groups"], [{"pgid": 300, "alive": 3}, {"pgid": 999, "alive": 0}])
        self.assertNotIn("sk-ant", str(snap))
        self.assertNotIn("abc123", str(snap))


class Refusals(unittest.TestCase):
    def test_what_may_not_be_signalled(self) -> None:
        table = rows()
        guarded = protected_pids(table, ctx())
        self.assertIn("system", refusal(table, 1, ctx(), guarded) or "")
        self.assertIn("this session's own Claude process", refusal(table, 101, ctx(), guarded) or "")
        self.assertIn("above this session", refusal(table, 100, ctx(), guarded) or "")
        self.assertIn("Session Monitor", refusal(table, 103, ctx(), guarded) or "")
        self.assertIn("Session Monitor", refusal(table, 106, ctx(), guarded) or "")
        self.assertIn("another user", refusal(table, 400, ctx(), guarded) or "")
        self.assertIn("no longer running", refusal(table, 9999, ctx(), guarded) or "")
        # Other sessions' processes and this session's children are allowed.
        self.assertIsNone(refusal(table, 200, ctx(), guarded))
        self.assertIsNone(refusal(table, 201, ctx(), guarded))
        self.assertIsNone(refusal(table, 105, ctx(), guarded))

    def test_groups_holding_claude_are_never_signalled_whole(self) -> None:
        table = rows()
        guarded = protected_pids(table, ctx())
        self.assertFalse(group_is_safe(table, 100, ctx(), guarded))
        self.assertFalse(group_is_safe(table, 200, ctx(), guarded))
        self.assertTrue(group_is_safe(table, 300, ctx(), guarded))
        self.assertTrue(group_is_safe(table, 104, ctx(), guarded))
        self.assertFalse(group_is_safe(table, 1, ctx(), guarded))


class Signals(unittest.TestCase):
    def test_signal_checks_identity_and_ownership_first(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        started = rows()[105].started_ms
        result = send_signal(machine, ctx(), "STOP", 105, started)
        self.assertTrue(result["ok"])
        self.assertEqual(machine.signals, [("kill", 105, SIGNALS["STOP"])])
        self.assertIn("Suspended python3 serve.py 9000 (105)", str(result["message"]))
        # A reused pid: same number, another start time.
        machine.signals.clear()
        result = send_signal(machine, ctx(), "TERM", 105, started - 60_000)
        self.assertFalse(result["ok"])
        self.assertIn("different process", str(result["message"]))
        self.assertEqual(machine.signals, [])
        for pid in (101, 103, 400, 1):
            result = send_signal(machine, ctx(), "KILL", pid, rows()[pid].started_ms)
            self.assertFalse(result["ok"], pid)
        self.assertEqual(machine.signals, [])
        self.assertFalse(send_signal(machine, ctx(), "HUP", 105, started)["ok"])

    def test_another_session_may_be_killed(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        result = send_signal(machine, ctx(), "TERM", 200, rows()[200].started_ms)
        self.assertTrue(result["ok"])
        self.assertEqual(machine.signals, [("kill", 200, SIGNALS["TERM"])])

    def test_cli_rejects_bad_arguments(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        self.assertFalse(main(["signal", "TERM", "abc", "1"], machine)["ok"])
        self.assertFalse(main(["dance"], machine)["ok"])
        self.assertEqual(machine.signals, [])


class Stop(unittest.TestCase):
    def test_stop_terms_the_whole_group_and_confirms_the_port_is_free(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        result = run_stop(machine, 8133, 5, ctx())
        self.assertTrue(result["ok"])
        self.assertTrue(result["isFree"])
        self.assertFalse(result["forced"])
        self.assertEqual(machine.signals, [("killpg", 300, SIGNALS["TERM"])])
        self.assertNotIn(301, machine.table)
        self.assertIn("process group 300", str(result["message"]))

    def test_stop_kills_what_ignores_sigterm_after_the_timeout(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        machine.stubborn = {302}
        result = run_stop(machine, 8133, 5, ctx())
        self.assertTrue(result["ok"])
        self.assertTrue(result["forced"])
        self.assertEqual(machine.signals, [("killpg", 300, SIGNALS["TERM"]), ("killpg", 300, SIGNALS["KILL"])])
        self.assertGreaterEqual(machine.clock - NOW, 5_000)

    def test_a_server_sharing_claudes_group_is_stopped_alone(self) -> None:
        # The listener sits in session 200's process group: only it and its
        # descendants are signalled, never the group.
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        plan = plan_stop(machine.table, [201], ctx())
        self.assertEqual(plan.groups, [])
        self.assertEqual(plan.pids, [201])
        result = run_stop(machine, 7000, 5, ctx())
        self.assertTrue(result["ok"])
        self.assertEqual(machine.signals, [("kill", 201, SIGNALS["TERM"])])
        self.assertIn(200, machine.table)

    def test_a_reused_pid_is_not_force_killed(self) -> None:
        # The listener ignores SIGTERM, exits at last, and its pid is reused by
        # another program before SIGKILL: that program is left alone.
        machine = ReusingSystem(rows(), parse_listeners(LSOF))
        machine.stubborn = {201}
        result = run_stop(machine, 7000, 5, ctx())
        self.assertTrue(result["ok"])
        self.assertEqual(machine.signals, [("kill", 201, SIGNALS["TERM"])])
        self.assertEqual(machine.table[201].exe, "/bin/other")

    def test_stop_refuses_this_sessions_claude_and_other_users(self) -> None:
        table = rows()
        machine = FakeSystem(table, [Listener(pid=101, port=8134, address="*", command="claude", uid=UID), Listener(pid=400, port=22, address="*", command="sshd", uid=0)])
        result = run_stop(machine, 8134, 5, ctx())
        self.assertFalse(result["ok"])
        self.assertIn("Claude", str(result["message"]))
        self.assertFalse(run_stop(machine, 22, 5, ctx())["ok"])
        self.assertEqual(machine.signals, [])

    def test_nothing_listening_is_already_free(self) -> None:
        machine = FakeSystem(rows(), [])
        self.assertEqual(run_stop(machine, 8134, 5, ctx())["isFree"], True)
        self.assertEqual(machine.signals, [])


class Launch(unittest.TestCase):
    def test_launch_argv_and_env(self) -> None:
        self.assertEqual(launch_argv("task dev:api"), WORKS_UNDER + ["task dev:api"])
        if IS_WINDOWS:
            env = launch_env({"Path": "C:\\Windows"}, "C:\\Users\\me")
            parts = env["Path"].split(os.pathsep)
            self.assertEqual(parts[0], "C:\\Windows")
            self.assertIn("C:\\Users\\me\\.bun\\bin", parts)
            self.assertEqual(len(parts), len(set(parts)))
            return
        env = launch_env({"PATH": "/usr/bin:/bin", "HOME": "/Users/me"}, "/Users/me")
        parts = env["PATH"].split(":")
        self.assertEqual(parts[:2], ["/usr/bin", "/bin"])
        self.assertIn("/opt/homebrew/bin", parts)
        self.assertIn("/Users/me/.bun/bin", parts)
        self.assertEqual(len(parts), len(set(parts)))

    def test_launch_refuses_a_taken_port(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        with tempfile.TemporaryDirectory() as folder:
            result = run_launch(machine, 8133, folder, "task dev", os.path.join(folder, "logs"), {"PATH": "/bin"})
        self.assertFalse(result["ok"])
        self.assertIn("bun run dev (pid 302)", str(result["message"]))
        self.assertEqual(machine.spawned, [])

    def test_launch_starts_detached_and_logs(self) -> None:
        machine = FakeSystem(rows(), parse_listeners(LSOF))
        with tempfile.TemporaryDirectory() as folder:
            logs = os.path.join(folder, "logs")
            result = run_launch(machine, 8134, folder, "task dev:api", logs, {"PATH": "/bin"})
            self.assertTrue(result["ok"])
            self.assertEqual(result["pid"], 4242)
            self.assertEqual(result["pgid"], 4242)
            argv, cwd, env = machine.spawned[0]
            self.assertEqual(argv, WORKS_UNDER + ["task dev:api"])
            self.assertEqual(cwd, folder)
            self.assertIn(".bun" if IS_WINDOWS else "/opt/homebrew/bin", env["PATH"])
            lines = read_tail(os.path.join(logs, "8134.log"))
            self.assertIn("starting `task dev:api`", lines[-2])
            self.assertEqual(lines[-1], "server output")

    def test_launch_refuses_a_missing_folder(self) -> None:
        machine = FakeSystem(rows(), [])
        self.assertFalse(run_launch(machine, 8134, "/no/such/folder", "task dev:api", "/tmp/unused", {"PATH": "/bin"})["ok"])
        self.assertEqual(machine.spawned, [])


class Tail(unittest.TestCase):
    def test_tail_strips_escapes_and_masks_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "8133.log")
            with open(path, "w", newline="") as handle:
                handle.write("".join(f"line {n}\n" for n in range(100)))
                handle.write("\x1b[32mready\x1b[0m in 300 ms\r\nSECRET_KEY=abc\n")
            lines = read_tail(path, max_lines=3)
            self.assertEqual(lines, ["line 99", "ready in 300 ms", "SECRET_KEY=***"])
            self.assertEqual(read_tail(path, max_bytes=45, max_lines=40), ["ready in 300 ms", "SECRET_KEY=***"])
        self.assertEqual(read_tail("/no/such/file"), [])


NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    0.0.0.0:8133           0.0.0.0:0              ABHÖREN         302
  TCP    [::]:8133              [::]:0                 ABHÖREN         302
  TCP    127.0.0.1:8134         0.0.0.0:0              LISTENING       303
  TCP    192.168.1.5:50123      142.250.1.1:443        ESTABLISHED     4040
"""


class WindowsNames(unittest.TestCase):
    def test_netstat_listeners_are_the_rows_with_a_wildcard_remote_whatever_the_language(self) -> None:
        found = parse_netstat_listeners(NETSTAT)
        self.assertEqual([(one.port, one.pid) for one in found], [(135, 1180), (8133, 302), (8134, 303)])
        self.assertEqual(found[1].address, "0.0.0.0 ::")

    def test_names_ignore_the_exe_suffix_and_the_slash_kind(self) -> None:
        self.assertEqual(base_name("C:\\Program Files\\nodejs\\node.exe"), "node")
        self.assertEqual(base_name("/usr/bin/node"), "node")
        self.assertTrue(is_abs("C:\\a") and is_abs("C:/a") and is_abs("/a") and not is_abs("node"))
        self.assertEqual(short_name("C:\\Program Files\\nodejs\\node.exe", "C:\\work\\app\\server.js --port 3000"), "node server.js 3000")

    def test_claude_is_found_by_its_windows_path(self) -> None:
        engine = Row(pid=9, ppid=1, pgid=0, uid=0, stat="S", started_ms=NOW, cpu_pct=0, mem_bytes=0, exe="C:\\Users\\me\\AppData\\Local\\Claude\\claude-code\\2.1.0\\claude.exe", args="--verbose")
        self.assertTrue(is_claude(engine))


if __name__ == "__main__":
    unittest.main()
