"""Unit tests for the sampler's pure parts: run with
/usr/bin/python3 -m unittest discover -s sampler -v   (from the mod folder)
"""

from __future__ import annotations

import re
import socket
import subprocess
import sys
import threading
import time
import unittest
from typing import Callable, Dict, List, Optional, Tuple

from sampler import (
    TICK_WRAP,
    CpuTicks,
    LatencyProbe,
    Mac,
    NetClock,
    Proc,
    Tracker,
    VmPages,
    cpu_busy_pct,
    extract_bash_command,
    fresh_latency,
    memory_used,
    parse_netstat,
    parse_nettop,
    redact,
    service_label,
    tcp_connect_ms,
)

ROOT = 100
ME = 999
SHELL_ARGV = [
    "/bin/zsh",
    "-c",
    "source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && "
    "setopt NO_EXTENDED_GLOB 2>/dev/null || true && "
    "eval 'echo '\"'\"'hi there'\"'\"' | wc -c' < /dev/null && pwd -P >| /tmp/claude-1-cwd",
]


def proc(
    pid: int,
    ppid: int,
    own: float = 0.0,
    child: float = 0.0,
    energy: float = 0.0,
    mem: int = 1000,
    disk_r: int = 0,
    start: Optional[int] = None,
) -> Proc:
    return Proc(
        pid=pid,
        ppid=ppid,
        start=start if start is not None else pid,
        started_at=0.0,
        own_cpu=own,
        child_cpu=child,
        energy_j=energy,
        mem=mem,
        peak_mem=mem,
        disk_r=disk_r,
        disk_w=0,
    )


def argv_for(*procs_: Proc) -> Dict[str, List[str]]:
    return {p.key: SHELL_ARGV for p in procs_}


class ParsingTests(unittest.TestCase):
    def test_extracts_the_command_with_escaped_quotes(self) -> None:
        self.assertEqual(extract_bash_command(SHELL_ARGV[2]), "echo 'hi there' | wc -c")

    def test_extracts_a_multiline_command(self) -> None:
        script = "source x/shell-snapshots/snapshot-1 && eval 'for i in 1 2\ndo echo $i\ndone' < /dev/null"
        self.assertEqual(extract_bash_command(script), "for i in 1 2\ndo echo $i\ndone")

    def test_returns_none_without_eval(self) -> None:
        self.assertIsNone(extract_bash_command("source x && ls"))

    def test_redacts_credential_arguments(self) -> None:
        text = "docker run -e QUANTCONNECT_API_TOKEN=abc123 -e USER_ID=5 -e MY_SECRET=zz img"
        self.assertEqual(
            redact(text), "docker run -e QUANTCONNECT_API_TOKEN=*** -e USER_ID=5 -e MY_SECRET=*** img"
        )

    def test_service_labels_skip_flags_and_secrets(self) -> None:
        argv = ["docker", "run", "-i", "--rm", "-e", "API_TOKEN=abc", "quantconnect/mcp-server"]
        self.assertEqual(service_label(argv), "docker run quantconnect/mcp-server")
        self.assertEqual(
            service_label(["npm exec @gitkraken/gk mcp --plugin --host=claude"]), "npm exec @gitkraken/gk mcp"
        )
        self.assertNotIn("abc", service_label(argv))

    def test_parses_nettop_including_dotted_names(self) -> None:
        text = ",bytes_in,bytes_out,\nclaude.78441,391069,1343620,\ncom.apple.WebKit.Networking.512,10,20,\n"
        self.assertEqual(parse_nettop(text), {78441: (391069, 1343620), 512: (10, 20)})

    def test_parses_netstat_link_rows_only(self) -> None:
        text = (
            "Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n"
            "lo0   16384 <Link#1>                      10     0 999 10     0 999     0\n"
            "en0   1500  <Link#15>   ba:40:19:56:23:72 5     0 1000 3     0 400     0\n"
            "en0   1500  192.168.1     192.168.1.5     5     - 1000 3     - 400     -\n"
            "en1   1500  <Link#10>   36:4c:72:72:62:40 0     0 50 0     0 5     0\n"
        )
        self.assertEqual(parse_netstat(text), (1050, 405))


class TrackerTests(unittest.TestCase):
    def make(self) -> Tracker:
        tracker = Tracker(root=ROOT, me=ME, ncpu=8)
        tracker.j_per_cpu_s = 2.0
        return tracker

    def bash_group(self, tracker: Tracker) -> Tuple[str, Dict[str, object]]:
        for group in tracker.groups.values():
            if group.kind == "bash":
                return group.id, {}
        raise AssertionError("no bash group")

    def test_folds_reaped_children_without_double_counting(self) -> None:
        tracker = self.make()
        shell = proc(200, ROOT, own=0.01)
        worker = proc(300, 200, own=0.5, energy=1.0)
        root = proc(ROOT, 1, own=5.0, energy=10.0)  # 2 J per CPU-second overall
        tracker.update([root, shell, worker], argv_for(shell), None, now=1.0)
        group_id, _ = self.bash_group(tracker)
        group = tracker.groups[group_id]
        self.assertEqual(group.label, "echo 'hi there' | wc -c")
        self.assertAlmostEqual(tracker.group_totals(group).cpu_s, 0.51)

        # The worker exits and the shell reaps it: its full 0.6 s lands in the
        # shell's child time, 0.1 s of which the sampler never saw.
        shell2 = proc(200, ROOT, own=0.01, child=0.6)
        tracker.update([root, shell2], argv_for(shell2), None, now=2.0)
        totals = tracker.group_totals(group)
        self.assertAlmostEqual(totals.cpu_s, 0.61)
        self.assertAlmostEqual(totals.energy_j, 1.0)
        self.assertAlmostEqual(totals.energy_est_j, (0.61 - 0.51) * 2.0)

    def test_assigns_the_root_reaped_tail_to_a_shell_that_just_ended(self) -> None:
        tracker = self.make()
        shell = proc(200, ROOT, own=0.01, child=0.2)
        tracker.update([proc(ROOT, 1, own=5.0, child=1.0), shell], argv_for(shell), None, now=1.0)
        tracker.emit(1.0)
        # Shell gone; root reaped 0.21 (seen) + 0.05 (unseen tail).
        tracker.update([proc(ROOT, 1, own=5.0, child=1.26)], {}, None, now=2.0)
        emitted = tracker.emit(2.0)
        ended = emitted["ended"]
        assert isinstance(ended, list)
        self.assertEqual(len(ended), 1)
        record = ended[0]
        assert isinstance(record, dict)
        tot = record["tot"]
        assert isinstance(tot, dict)
        self.assertAlmostEqual(float(tot["cpuS"]), 0.26, places=4)
        self.assertIn("endedAt", record)
        reaped = emitted["reaped"]
        assert isinstance(reaped, dict)
        self.assertEqual(reaped["cpuS"], 0.0)

    def test_reports_unclaimed_reaped_cpu_when_no_shell_was_seen(self) -> None:
        tracker = self.make()
        tracker.update([proc(ROOT, 1, own=5.0, child=1.0)], {}, None, now=1.0)
        tracker.update([proc(ROOT, 1, own=5.0, child=1.3)], {}, None, now=2.0)
        reaped = tracker.emit(2.0)["reaped"]
        assert isinstance(reaped, dict)
        self.assertAlmostEqual(float(reaped["cpuS"]), 0.3)
        self.assertAlmostEqual(float(reaped["energyEstJ"]), 0.6)

    def test_network_totals_never_go_backwards(self) -> None:
        tracker = self.make()
        root = proc(ROOT, 1, own=1.0)
        tracker.update([root], {}, {ROOT: (1000, 500)}, now=1.0)
        tracker.update([root], {}, {ROOT: (1500, 700)}, now=2.0)
        tracker.update([root], {}, {ROOT: (200, 100)}, now=3.0)  # a flow closed
        tracker.update([root], {}, {ROOT: (300, 150)}, now=4.0)
        totals = tracker.claude_totals()
        self.assertEqual((totals.net_in, totals.net_out), (1600, 750))

    def test_counts_this_sampler_as_the_monitor(self) -> None:
        tracker = self.make()
        me = proc(ME, 400, own=0.2)
        host = proc(400, ROOT, own=1.0)
        tracker.update([proc(ROOT, 1), host, me, proc(1000, ME, own=0.01)], {host.key: ["bun", "worker"]}, None, 1.0)
        self.assertEqual(len(tracker.groups["monitor"].members), 2)
        kinds = sorted(g.kind for g in tracker.groups.values())
        self.assertEqual(kinds, ["claude", "helper", "monitor"])

    def test_session_totals_include_root_child_time_and_live_descendants(self) -> None:
        tracker = self.make()
        shell = proc(200, ROOT, own=0.3, energy=0.6)
        tracker.update([proc(ROOT, 1, own=5.0, child=2.0, energy=10.0), shell], argv_for(shell), None, now=1.0)
        totals = tracker.session_totals()
        self.assertAlmostEqual(totals.cpu_s, 7.3)
        self.assertAlmostEqual(totals.energy_j, 10.6)
        self.assertAlmostEqual(totals.energy_est_j, 2.0 * 2.0)

    def test_net_clock_counts_only_intervals_where_bytes_moved(self) -> None:
        clock = NetClock()
        clock.observe(100, 1.0)  # first reading: nothing to compare yet
        clock.observe(100, 2.0)  # idle second
        clock.observe(900, 2.5)  # bytes moved over 0.5 s
        clock.observe(2000, 3.5)  # and over the next 1.0 s
        clock.observe(2000, 4.5)  # idle again
        self.assertAlmostEqual(clock.active_s, 1.5)

    def test_reports_network_active_time_per_group_and_session(self) -> None:
        tracker = self.make()
        root = proc(ROOT, 1, own=1.0)
        shell = proc(200, ROOT, own=0.1)
        argv = argv_for(shell)
        tracker.update([root, shell], argv, {ROOT: (0, 0), 200: (0, 0)}, now=1.0)
        tracker.update([root, shell], argv, {ROOT: (0, 0), 200: (5000, 10)}, now=2.0)
        tracker.update([root, shell], argv, {ROOT: (300, 0), 200: (5000, 10)}, now=3.0)
        emitted = tracker.emit(3.0)
        raw_groups = emitted["groups"]
        assert isinstance(raw_groups, list)
        groups: Dict[str, Dict[str, object]] = {}
        for group in raw_groups:
            assert isinstance(group, dict)
            groups[str(group["kind"])] = group
        bash_tot = groups["bash"]["tot"]
        claude_tot = groups["claude"]["tot"]
        session = emitted["session"]
        assert isinstance(bash_tot, dict) and isinstance(claude_tot, dict) and isinstance(session, dict)
        self.assertAlmostEqual(float(bash_tot["netActiveS"]), 1.0)
        self.assertAlmostEqual(float(claude_tot["netActiveS"]), 1.0)
        self.assertAlmostEqual(float(session["netActiveS"]), 2.0)

    def test_rates_follow_totals_between_emits(self) -> None:
        tracker = self.make()
        tracker.update([proc(ROOT, 1, own=1.0, energy=1.0)], {}, {ROOT: (0, 0)}, now=1.0)
        tracker.emit(1.0)
        tracker.update([proc(ROOT, 1, own=1.5, energy=3.0)], {}, {ROOT: (2000, 1000)}, now=3.0)
        session = tracker.emit(3.0)["session"]
        assert isinstance(session, dict)
        self.assertAlmostEqual(float(session["cpuPct"]), 25.0)
        self.assertAlmostEqual(float(session["watts"]), 1.0)
        self.assertAlmostEqual(float(session["netInBps"]), 1000.0)


def ticks(user: int, system: int, idle: int, nice: int = 0) -> CpuTicks:
    return CpuTicks(user=user, system=system, idle=idle, nice=nice)


def share(before: CpuTicks, after: CpuTicks) -> float:
    pct = cpu_busy_pct(before, after)
    assert pct is not None
    return pct


def system_of(tracker: Tracker, now: float) -> Dict[str, float]:
    """The whole Mac's figures as the next tick carries them."""
    figures = tracker.system_json()
    assert tracker.emit(now)["system"] == figures
    return figures


def wait_for(condition: Callable[[], bool], timeout_s: float = 5.0) -> bool:
    """Polls `condition` until it holds or the time runs out."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.005)
    return False


class MachineTests(unittest.TestCase):
    def test_cpu_share_is_the_busy_ticks_over_all_ticks_between_readings(self) -> None:
        # 16 cores for one second: 1600 ticks, 300 of them user, system or nice.
        before = ticks(user=1_000, system=500, idle=9_000, nice=10)
        after = ticks(user=1_200, system=590, idle=10_300, nice=20)
        self.assertAlmostEqual(share(before, after), 300 / 1_600 * 100)
        self.assertEqual(share(after, ticks(user=1_200, system=590, idle=10_400, nice=20)), 0.0)

    def test_cpu_share_needs_a_tick_between_readings(self) -> None:
        reading = ticks(user=5, system=5, idle=90)
        self.assertIsNone(cpu_busy_pct(reading, reading))

    def test_cpu_ticks_count_across_a_counter_wrap(self) -> None:
        before = ticks(user=TICK_WRAP - 50, system=0, idle=TICK_WRAP - 100)
        after = ticks(user=50, system=0, idle=200)  # 100 user and 300 idle ticks later
        self.assertAlmostEqual(share(before, after), 25.0)

    def test_memory_used_adds_app_wired_and_compressed_pages(self) -> None:
        pages = VmPages(internal=1_000, purgeable=100, wired=200, compressor=300)
        self.assertEqual(memory_used(pages, 16_384), (900 + 200 + 300) * 16_384)
        # Purgeable pages beyond the anonymous ones leave no app memory, never less.
        self.assertEqual(memory_used(VmPages(internal=10, purgeable=50, wired=1, compressor=2), 4_096), 3 * 4_096)

    def test_a_latency_counts_until_it_is_stale(self) -> None:
        self.assertIsNone(fresh_latency(None, 100.0, 30.0))
        self.assertEqual(fresh_latency((38.5, 100.0), 130.0, 30.0), 38.5)
        self.assertIsNone(fresh_latency((38.5, 100.0), 130.5, 30.0))

    def test_the_tick_carries_the_whole_mac_once_measured(self) -> None:
        tracker = Tracker(root=ROOT, me=ME, ncpu=8)
        tracker.set_system((1_000, 500), 1.0)
        tracker.set_machine(ticks(user=100, system=100, idle=800), 6_000_000_000, 16_000_000_000, None)
        # One CPU reading is no share yet, and a failed probe is no latency.
        self.assertEqual(
            system_of(tracker, 1.0),
            {"netInBps": 0.0, "netOutBps": 0.0, "netIn": 0, "netOut": 0, "memUsed": 6_000_000_000, "memTotal": 16_000_000_000},
        )
        tracker.set_system((3_000, 900), 2.0)
        tracker.set_machine(ticks(user=175, system=125, idle=1_100), 6_500_000_000, 16_000_000_000, 38.26)
        self.assertEqual(
            system_of(tracker, 2.0),
            {
                "netInBps": 2_000.0,
                "netOutBps": 400.0,
                "netIn": 2_000,
                "netOut": 400,
                "cpuPct": 25.0,  # 100 busy ticks of 400
                "memUsed": 6_500_000_000,
                "memTotal": 16_000_000_000,
                "latencyMs": 38.3,
            },
        )

    def test_a_reading_with_no_tick_since_the_last_keeps_the_share(self) -> None:
        tracker = Tracker(root=ROOT, me=ME, ncpu=8)
        tracker.set_machine(ticks(user=0, system=0, idle=0), None, None, None)
        tracker.set_machine(ticks(user=50, system=0, idle=50), None, None, None)
        tracker.set_machine(ticks(user=50, system=0, idle=50), None, None, None)
        self.assertEqual(system_of(tracker, 1.0)["cpuPct"], 50.0)
        tracker.set_machine(ticks(user=50, system=0, idle=150), None, None, None)
        self.assertEqual(system_of(tracker, 2.0)["cpuPct"], 0.0)

    def test_a_failed_reading_is_no_figure(self) -> None:
        tracker = Tracker(root=ROOT, me=ME, ncpu=8)
        tracker.set_machine(ticks(user=0, system=0, idle=0), 1, 2, 3.0)
        tracker.set_machine(ticks(user=10, system=0, idle=10), 1, 2, 3.0)
        tracker.set_machine(None, None, None, None)
        system = system_of(tracker, 1.0)
        for key in ("cpuPct", "memUsed", "memTotal", "latencyMs"):
            self.assertNotIn(key, system)
        # After a failed CPU reading the share starts over: the next reading is the first.
        tracker.set_machine(ticks(user=10, system=0, idle=10), None, None, None)
        self.assertNotIn("cpuPct", system_of(tracker, 2.0))


class LatencyProbeTests(unittest.TestCase):
    def test_times_a_tcp_connect_and_fails_on_a_closed_port(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = int(server.getsockname()[1])
            ms = tcp_connect_ms("127.0.0.1", port, 1.0)
            assert ms is not None
            self.assertGreaterEqual(ms, 0.0)
            self.assertLess(ms, 1_000.0)
        # The listener is gone: the connect is refused.
        self.assertIsNone(tcp_connect_ms("127.0.0.1", port, 1.0))

    def test_a_hanging_probe_never_holds_the_reader_up(self) -> None:
        release = threading.Event()
        results: List[Optional[float]] = [42.0, None]

        def measure() -> Optional[float]:
            release.wait(5.0)
            release.clear()
            return results.pop(0) if results else None

        probe = LatencyProbe(measure, every_s=0.01, stale_s=60.0)
        probe.start()
        try:
            started = time.monotonic()
            self.assertIsNone(probe.value())  # the first probe hangs: nothing known yet
            self.assertLess(time.monotonic() - started, 0.5)
            release.set()
            self.assertTrue(wait_for(lambda: probe.value() == 42.0))
            release.set()  # the next probe fails: no latency, not the last one
            self.assertTrue(wait_for(lambda: probe.value() is None))
        finally:
            probe.stop()
            release.set()


@unittest.skipUnless(sys.platform == "darwin", "the host counters are macOS only")
class MacSmokeTests(unittest.TestCase):
    """The ctypes calls against this Mac, checked against sysctl and vm_stat."""

    def test_reads_the_ram_the_page_size_and_the_memory_in_use(self) -> None:
        mac = Mac()
        ram = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout)
        self.assertEqual(mac.mem_total, ram)
        vm_stat = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        match = re.search(r"page size of (\d+) bytes", vm_stat)
        assert match is not None
        self.assertEqual(mac.page_size, int(match.group(1)))
        used = mac.memory_used()
        assert used is not None
        self.assertGreater(used, 0)
        self.assertLessEqual(used, ram)

    def test_reads_cpu_ticks_and_a_share_between_two(self) -> None:
        mac = Mac()
        first = mac.cpu_ticks()
        assert first is not None
        self.assertGreater(first.idle, 0)
        tracker = Tracker(root=ROOT, me=ME, ncpu=8)
        tracker.set_machine(first, mac.memory_used(), mac.mem_total, None)
        time.sleep(0.1)
        tracker.set_machine(mac.cpu_ticks(), mac.memory_used(), mac.mem_total, None)
        system = system_of(tracker, 1.0)
        pct = system["cpuPct"]
        self.assertGreaterEqual(pct, 0.0)
        self.assertLessEqual(pct, 100.0)
        self.assertIn("memUsed", system)


if __name__ == "__main__":
    unittest.main()
