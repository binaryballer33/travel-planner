#!/usr/bin/env python3
"""Session Monitor sampler.

Walks the Claude Code process tree several times a second and prints one JSON
line per emit: CPU, memory, energy, disk and network for the Claude engine, each
MCP / service child, each Bash tool shell (its command decoded from the shell's
argv), the short-lived helpers, and this sampler itself.

Each emit also carries the whole Mac: its CPU in use, its memory in use, its
network, and how long a TCP connect to the Claude API takes.

macOS only, standard library only (Python 3.9+). Everything is read without
root: per-process counters come from libproc's proc_pid_rusage (rusage_info_v6,
which carries the kernel's energy estimate in nanojoules), the process tree from
proc_listchildpids, argv from sysctl KERN_PROCARGS2, per-process network bytes
from nettop and machine-wide bytes from netstat. The machine's CPU ticks come
from host_statistics (HOST_CPU_LOAD_INFO), its memory pages from
host_statistics64 (HOST_VM_INFO64) and its RAM from sysctl hw.memsize; the
latency probe runs on a thread of its own, so a slow network never holds up a
tick.

The accounting (Tracker) is pure and is unit-tested with synthetic samples; the
OS layer (Mac) is a thin ctypes wrapper.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

SHELL_MARK = "shell-snapshots/snapshot-"
SERVICE_AGE_S = 5.0
FAST_TICK_S = 0.25
IDLE_TICK_S = 1.0
EMIT_EVERY_S = 1.0
BUSY_NET_S = 0.5
DEFAULT_J_PER_CPU_S = 1.5
#: Where the latency probe connects: the Claude API's host.
LATENCY_HOST = "api.anthropic.com"
LATENCY_PORT = 443
PROBE_EVERY_S = 15.0
PROBE_TIMEOUT_S = 3.0
#: How many of the host's addresses a probe tries in turn: an IPv6 one may not
#: route where the IPv4 one does.
PROBE_ADDRESSES = 2
#: A probe older than this no longer counts: the later ones have not finished (a
#: name lookup can hang while the Mac is offline).
PROBE_STALE_S = 2 * PROBE_EVERY_S + PROBE_TIMEOUT_S
#: The host's CPU tick counters are 32 bits wide and wrap.
TICK_WRAP = 1 << 32
SECRET_ARG = re.compile(
    r"([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=\S+",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #


def redact(text: str) -> str:
    """Masks KEY=value arguments whose key looks like a credential."""
    return SECRET_ARG.sub(lambda m: f"{m.group(1)}=***", text)


def read_shell_word(text: str, start: int) -> Optional[str]:
    """Reads one shell word made of '...' and "..." segments starting at `start`."""
    out: List[str] = []
    i = start
    n = len(text)
    while i < n and not text[i].isspace():
        ch = text[i]
        if ch == "'":
            end = text.find("'", i + 1)
            if end < 0:
                return None
            out.append(text[i + 1 : end])
            i = end + 1
        elif ch == '"':
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n and text[i + 1] in '"\\$`':
                    out.append(text[i + 1])
                    i += 2
                else:
                    out.append(text[i])
                    i += 1
            if i >= n:
                return None
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def extract_bash_command(script: str) -> Optional[str]:
    """The command a Claude Code Bash tool shell runs: the word after `eval `."""
    at = script.rfind(" && eval ")
    if at < 0:
        at = script.find("eval ")
        if at < 0:
            return None
        at += len("eval ")
    else:
        at += len(" && eval ")
    return read_shell_word(script, at)


def is_tool_shell(argv: List[str]) -> bool:
    return any(SHELL_MARK in arg for arg in argv)


def service_label(argv: List[str]) -> str:
    """A short, secret-free name for a long-lived child (an MCP server, an LSP)."""
    tokens = " ".join(argv).split()
    if not tokens:
        return "process"
    words = [os.path.basename(tokens[0])]
    for token in tokens[1:]:
        if len(words) >= 4:
            break
        if token.startswith("-") or "=" in token:
            continue
        words.append(os.path.basename(token) if token.startswith("/") else token)
    return redact(" ".join(words))[:60]


def parse_nettop(text: str) -> Dict[int, Tuple[int, int]]:
    """`nettop -P -L 1 -x -n -J bytes_in,bytes_out` -> {pid: (bytes_in, bytes_out)}."""
    result: Dict[int, Tuple[int, int]] = {}
    for line in text.splitlines():
        fields = line.split(",")
        if len(fields) < 4 or fields[0] == "":
            continue
        name = ",".join(fields[:-3])
        dot = name.rfind(".")
        if dot < 0:
            continue
        try:
            pid = int(name[dot + 1 :])
            result[pid] = (int(fields[-3]), int(fields[-2]))
        except ValueError:
            continue
    return result


def parse_netstat(text: str) -> Tuple[int, int]:
    """`netstat -ib -n` -> machine-wide (bytes_in, bytes_out) over en* / pdp_ip*."""
    total_in = 0
    total_out = 0
    for line in text.splitlines():
        cols = line.split()
        if len(cols) < 10 or "<Link#" not in cols[2]:
            continue
        if not re.match(r"^(en|pdp_ip)\d+$", cols[0]):
            continue
        # With a MAC address: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
        # Without one the Address column is missing, so read from the right.
        try:
            total_in += int(cols[-5])
            total_out += int(cols[-2])
        except ValueError:
            continue
    return total_in, total_out


@dataclass(frozen=True)
class CpuTicks:
    """The machine's CPU time since boot in scheduler ticks, summed over every core."""

    user: int
    system: int
    idle: int
    nice: int


def tick_delta(before: int, after: int) -> int:
    """Ticks between two readings of a 32-bit counter, across a wrap."""
    return (after - before) % TICK_WRAP


def cpu_busy_pct(before: CpuTicks, after: CpuTicks) -> Optional[float]:
    """The share of the whole machine's CPU time spent working between two
    readings, in percent (0-100); None when no tick passed between them."""
    busy = tick_delta(before.user, after.user) + tick_delta(before.system, after.system) + tick_delta(before.nice, after.nice)
    total = busy + tick_delta(before.idle, after.idle)
    if total <= 0:
        return None
    return busy / total * 100


@dataclass(frozen=True)
class VmPages:
    """The page counts Activity Monitor's Memory Used is made of."""

    internal: int  # anonymous pages: what apps allocated, purgeable ones included
    purgeable: int
    wired: int
    compressor: int  # the pages the compressor occupies


def memory_used(pages: VmPages, page_size: int) -> int:
    """Activity Monitor's Memory Used in bytes: app memory (anonymous pages
    less purgeable ones), wired memory and compressed memory."""
    app = max(0, pages.internal - pages.purgeable)
    return (app + pages.wired + pages.compressor) * page_size


def fresh_latency(latest: Optional[Tuple[float, float]], now: float, stale_s: float) -> Optional[float]:
    """A probe's connect time in ms, from (ms, when it was taken), while it is
    no older than `stale_s`; None without one."""
    if latest is None or now - latest[1] > stale_s:
        return None
    return latest[0]


# --------------------------------------------------------------------------- #
# Accounting
# --------------------------------------------------------------------------- #


@dataclass
class Proc:
    """One process at one moment. Times in seconds, energy in joules."""

    pid: int
    ppid: int
    start: int  # mach absolute time: with pid, a key that survives pid reuse
    started_at: float  # wall clock
    own_cpu: float
    child_cpu: float
    energy_j: float
    mem: int
    peak_mem: int
    disk_r: int
    disk_w: int

    @property
    def key(self) -> str:
        return f"{self.pid}:{self.start}"

    @property
    def total_cpu(self) -> float:
        return self.own_cpu + self.child_cpu


@dataclass
class Totals:
    cpu_s: float = 0.0
    energy_j: float = 0.0
    energy_est_j: float = 0.0
    net_in: int = 0
    net_out: int = 0
    disk_r: int = 0
    disk_w: int = 0
    net_active_s: float = 0.0

    def as_json(self) -> Dict[str, float]:
        return {
            "netActiveS": round(self.net_active_s, 3),
            "cpuS": round(self.cpu_s, 4),
            "energyJ": round(self.energy_j, 4),
            "energyEstJ": round(self.energy_est_j, 4),
            "netIn": self.net_in,
            "netOut": self.net_out,
            "diskR": self.disk_r,
            "diskW": self.disk_w,
        }


@dataclass
class Gone:
    """Running sums of members that exited: their last observed counters."""

    own_cpu: float = 0.0
    energy_j: float = 0.0
    disk_r: int = 0
    disk_w: int = 0
    net_in: int = 0
    net_out: int = 0


@dataclass
class NetClock:
    """Seconds during which a byte count grew, judged between network readings."""

    active_s: float = 0.0
    mark: Optional[Tuple[int, float]] = None

    def observe(self, total: int, now: float) -> None:
        if self.mark is not None and total > self.mark[0] and now > self.mark[1]:
            self.active_s += now - self.mark[1]
        self.mark = (total, now)


@dataclass
class Group:
    id: str
    kind: str  # claude | bash | service | helper | monitor
    label: str
    pid: int
    started_at: float
    cmd: Optional[str] = None
    members: Dict[str, Proc] = field(default_factory=dict)
    gone: Gone = field(default_factory=Gone)
    cpu_hw: float = 0.0
    tail_cpu: float = 0.0
    peak_mem: int = 0
    ended_at: Optional[float] = None
    prev: Optional[Totals] = None
    prev_t: float = 0.0
    net_clock: NetClock = field(default_factory=NetClock)


class Tracker:
    """Folds process snapshots into per-group and per-session totals and rates."""

    def __init__(self, root: int, me: int, ncpu: int) -> None:
        self.root = root
        self.me = me
        self.ncpu = ncpu
        self.groups: Dict[str, Group] = {}
        self.procs: Dict[str, Proc] = {}
        self.proc_group: Dict[str, str] = {}
        self.net: Dict[str, Tuple[int, int]] = {}  # per proc key: accumulated (in, out)
        self.net_raw: Dict[str, Tuple[int, int]] = {}  # per proc key: last nettop reading
        self.ended: List[Group] = []
        self.root_proc: Optional[Proc] = None
        self.session_gone = Gone()
        self.session_net_clock = NetClock()
        self.session_cpu_hw = 0.0
        self.reaped_unclaimed_cpu = 0.0
        self.j_per_cpu_s = DEFAULT_J_PER_CPU_S
        self.session_prev: Optional[Totals] = None
        self.session_prev_t = 0.0
        self.system_prev: Optional[Tuple[int, int]] = None
        self.system_prev_t = 0.0
        self.system_rates: Tuple[float, float] = (0.0, 0.0)
        self.system_totals: Tuple[int, int] = (0, 0)
        self.system_base: Optional[Tuple[int, int]] = None
        # The whole Mac's CPU, memory and latency: None while not known.
        self.cpu_prev: Optional[CpuTicks] = None
        self.cpu_pct: Optional[float] = None
        self.mem_used: Optional[int] = None
        self.mem_total: Optional[int] = None
        self.latency_ms: Optional[float] = None

    # -- classification ----------------------------------------------------- #

    def _group_for(
        self, proc: Proc, by_pid: Dict[int, Proc], argv: Dict[str, List[str]], now: float
    ) -> Optional[str]:
        """The group a live descendant belongs to: its top ancestor below root."""
        cursor = proc
        seen = 0
        while cursor.ppid != self.root:
            if cursor.pid == self.me:
                return "monitor"
            parent = by_pid.get(cursor.ppid)
            if parent is None or seen > 64:
                return None
            cursor = parent
            seen += 1
        if cursor.pid == self.me:
            return "monitor"
        top = cursor
        group_id = f"p:{top.key}"
        if group_id not in self.groups:
            args = argv.get(top.key, [])
            if is_tool_shell(args):
                script = args[-1] if args else ""
                command = extract_bash_command(script)
                self.groups[group_id] = Group(
                    id=group_id,
                    kind="bash",
                    label=(command or "shell").split("\n", 1)[0][:200],
                    pid=top.pid,
                    started_at=top.started_at,
                    cmd=(command or "")[:4000],
                )
            else:
                self.groups[group_id] = Group(
                    id=group_id,
                    kind="helper",
                    label=service_label(args),
                    pid=top.pid,
                    started_at=top.started_at,
                )
        group = self.groups[group_id]
        if group.kind == "helper" and now - group.started_at >= SERVICE_AGE_S:
            group.kind = "service"
        return group_id

    # -- one sample --------------------------------------------------------- #

    def update(
        self,
        live: List[Proc],
        argv: Dict[str, List[str]],
        nettop: Optional[Dict[int, Tuple[int, int]]],
        now: float,
    ) -> None:
        by_pid = {p.pid: p for p in live}
        root = by_pid.get(self.root)
        previous_root = self.root_proc
        if root is not None:
            self.root_proc = root
        if "claude" not in self.groups and root is not None:
            self.groups["claude"] = Group(
                id="claude", kind="claude", label="Claude engine (API, web tools)", pid=self.root, started_at=now
            )
        if "monitor" not in self.groups:
            self.groups["monitor"] = Group(
                id="monitor", kind="monitor", label="Session Monitor (this mod)", pid=self.me, started_at=now
            )

        # Network: accumulate positive deltas per process so closed flows never
        # make a total go backwards.
        if nettop is not None:
            for p in live:
                reading = nettop.get(p.pid)
                if reading is None:
                    continue
                last = self.net_raw.get(p.key)
                acc_in, acc_out = self.net.get(p.key, (0, 0))
                if last is None:
                    acc_in, acc_out = reading
                else:
                    acc_in += max(0, reading[0] - last[0])
                    acc_out += max(0, reading[1] - last[1])
                self.net_raw[p.key] = reading
                self.net[p.key] = (acc_in, acc_out)

        # Calibrate joules per CPU-second from processes the kernel measured.
        measured_cpu = sum(p.own_cpu for p in live if p.energy_j > 0)
        measured_j = sum(p.energy_j for p in live if p.energy_j > 0)
        if measured_cpu > 1.0 and measured_j > 0:
            self.j_per_cpu_s = measured_j / measured_cpu

        # Membership.
        live_keys = set()
        new_members: Dict[str, Dict[str, Proc]] = {}
        for p in live:
            if p.pid == self.root:
                continue
            group_id = self._group_for(p, by_pid, argv, now)
            if group_id is None:
                continue
            live_keys.add(p.key)
            new_members.setdefault(group_id, {})[p.key] = p
            self.proc_group[p.key] = group_id

        # Vanished processes: fold their last counters into the gone sums.
        vanished_direct: List[Tuple[Group, Proc]] = []
        for key, old in list(self.procs.items()):
            if key in live_keys:
                continue
            group_id = self.proc_group.pop(key, None)
            net_in, net_out = self.net.pop(key, (0, 0))
            self.net_raw.pop(key, None)
            for gone in (self.session_gone, self.groups[group_id].gone if group_id in self.groups else None):
                if gone is None:
                    continue
                gone.own_cpu += old.own_cpu
                gone.energy_j += old.energy_j
                gone.disk_r += old.disk_r
                gone.disk_w += old.disk_w
                gone.net_in += net_in
                gone.net_out += net_out
            if old.ppid == self.root and group_id in self.groups:
                vanished_direct.append((self.groups[group_id], old))
            del self.procs[key]
        for p in live:
            if p.key in live_keys:
                self.procs[p.key] = p

        for group_id, group in self.groups.items():
            if group.ended_at is not None or group.kind in ("claude",):
                continue
            group.members = new_members.get(group_id, {})
            live_cpu = sum(m.total_cpu for m in group.members.values())
            group.cpu_hw = max(group.cpu_hw, live_cpu)
            group.peak_mem = max(
                group.peak_mem,
                sum(m.mem for m in group.members.values()),
                max((m.peak_mem for m in group.members.values()), default=0),
            )

        # CPU the root reaped this tick that no observed child explains: the tail
        # of a command that just ended, or a command too short to be seen.
        if root is not None and previous_root is not None and previous_root.key == root.key:
            reaped = root.child_cpu - previous_root.child_cpu
            explained = sum(proc.total_cpu for _, proc in vanished_direct)
            unexplained = max(0.0, reaped - explained)
            ended_shells = [
                g for g, proc in vanished_direct if g.kind == "bash" and g.pid == proc.pid and not g.members
            ]
            if ended_shells and unexplained > 0:
                share = unexplained / len(ended_shells)
                for group in ended_shells:
                    group.tail_cpu += share
            else:
                self.reaped_unclaimed_cpu += unexplained

        # Groups whose every process is gone have ended.
        for group_id, group in self.groups.items():
            if group.ended_at is None and group.kind not in ("monitor", "claude") and not group.members:
                group.ended_at = now
                self.ended.append(group)

        if nettop is not None:
            for group in self.groups.values():
                if group.ended_at is None:
                    group.net_clock.observe(self._group_net(group), now)
            self.session_net_clock.observe(self._session_net(), now)

        live_total = sum(p.total_cpu for p in live if p.pid != self.root)
        if root is not None:
            self.session_cpu_hw = max(self.session_cpu_hw, root.own_cpu + root.child_cpu + live_total)

    # -- totals ------------------------------------------------------------- #

    def _group_net(self, group: Group) -> int:
        if group.kind == "claude":
            root = self.root_proc
            acc = self.net.get(root.key, (0, 0)) if root is not None else (0, 0)
            return acc[0] + acc[1]
        total = group.gone.net_in + group.gone.net_out
        for key in group.members:
            acc = self.net.get(key, (0, 0))
            total += acc[0] + acc[1]
        return total

    def _session_net(self) -> int:
        total = self.session_gone.net_in + self.session_gone.net_out
        keys = list(self.procs)
        if self.root_proc is not None:
            keys.append(self.root_proc.key)
        for key in keys:
            acc = self.net.get(key, (0, 0))
            total += acc[0] + acc[1]
        return total

    def group_totals(self, group: Group) -> Totals:
        cpu = group.cpu_hw + group.tail_cpu
        observed_own = sum(m.own_cpu for m in group.members.values()) + group.gone.own_cpu
        energy = sum(m.energy_j for m in group.members.values()) + group.gone.energy_j
        estimated = max(0.0, cpu - observed_own) * self.j_per_cpu_s
        net_in = group.gone.net_in
        net_out = group.gone.net_out
        for key in group.members:
            acc = self.net.get(key, (0, 0))
            net_in += acc[0]
            net_out += acc[1]
        return Totals(
            net_active_s=group.net_clock.active_s,
            cpu_s=cpu,
            energy_j=energy,
            energy_est_j=estimated,
            net_in=net_in,
            net_out=net_out,
            disk_r=sum(m.disk_r for m in group.members.values()) + group.gone.disk_r,
            disk_w=sum(m.disk_w for m in group.members.values()) + group.gone.disk_w,
        )

    def claude_totals(self) -> Totals:
        root = self.root_proc
        if root is None:
            return Totals()
        acc = self.net.get(root.key, (0, 0))
        claude = self.groups.get("claude")
        return Totals(
            net_active_s=claude.net_clock.active_s if claude is not None else 0.0,
            cpu_s=root.own_cpu,
            energy_j=root.energy_j,
            net_in=acc[0],
            net_out=acc[1],
            disk_r=root.disk_r,
            disk_w=root.disk_w,
        )

    def session_totals(self) -> Totals:
        live = list(self.procs.values())
        root = self.root_proc
        if root is not None:
            live = live + [root]
        observed_own = sum(p.own_cpu for p in live) + self.session_gone.own_cpu
        energy = sum(p.energy_j for p in live) + self.session_gone.energy_j
        net_in = self.session_gone.net_in
        net_out = self.session_gone.net_out
        for p in live:
            acc = self.net.get(p.key, (0, 0))
            net_in += acc[0]
            net_out += acc[1]
        return Totals(
            net_active_s=self.session_net_clock.active_s,
            cpu_s=self.session_cpu_hw,
            energy_j=energy,
            energy_est_j=max(0.0, self.session_cpu_hw - observed_own) * self.j_per_cpu_s,
            net_in=net_in,
            net_out=net_out,
            disk_r=sum(p.disk_r for p in live) + self.session_gone.disk_r,
            disk_w=sum(p.disk_w for p in live) + self.session_gone.disk_w,
        )

    @staticmethod
    def rates(now_totals: Totals, prev: Optional[Totals], dt: float) -> Dict[str, float]:
        if prev is None or dt <= 0:
            return {"cpuPct": 0.0, "watts": 0.0, "netInBps": 0.0, "netOutBps": 0.0, "diskRBps": 0.0, "diskWBps": 0.0}
        energy_now = now_totals.energy_j + now_totals.energy_est_j
        energy_prev = prev.energy_j + prev.energy_est_j
        return {
            "cpuPct": round(max(0.0, now_totals.cpu_s - prev.cpu_s) / dt * 100, 2),
            "watts": round(max(0.0, energy_now - energy_prev) / dt, 3),
            "netInBps": round(max(0, now_totals.net_in - prev.net_in) / dt, 1),
            "netOutBps": round(max(0, now_totals.net_out - prev.net_out) / dt, 1),
            "diskRBps": round(max(0, now_totals.disk_r - prev.disk_r) / dt, 1),
            "diskWBps": round(max(0, now_totals.disk_w - prev.disk_w) / dt, 1),
        }

    def _group_json(self, group: Group, now: float) -> Dict[str, object]:
        totals = self.claude_totals() if group.kind == "claude" else self.group_totals(group)
        rates = self.rates(totals, group.prev, now - group.prev_t)
        group.prev = totals
        group.prev_t = now
        mem = (
            (self.root_proc.mem if self.root_proc else 0)
            if group.kind == "claude"
            else sum(m.mem for m in group.members.values())
        )
        peak = (self.root_proc.peak_mem if self.root_proc else 0) if group.kind == "claude" else group.peak_mem
        record: Dict[str, object] = {
            "id": group.id,
            "kind": group.kind,
            "label": group.label,
            "pid": group.pid,
            "procs": 1 if group.kind == "claude" else len(group.members),
            "startedAt": round(group.started_at, 3),
            "mem": mem,
            "peakMem": peak,
            "tot": totals.as_json(),
        }
        record.update(rates)
        if group.cmd is not None:
            record["cmd"] = group.cmd
        if group.ended_at is not None:
            record["endedAt"] = round(group.ended_at, 3)
        return record

    def set_system(self, reading: Optional[Tuple[int, int]], now: float) -> None:
        if reading is None:
            return
        if self.system_base is None:
            self.system_base = reading
        if self.system_prev is not None and now > self.system_prev_t:
            dt = now - self.system_prev_t
            self.system_rates = (
                max(0, reading[0] - self.system_prev[0]) / dt,
                max(0, reading[1] - self.system_prev[1]) / dt,
            )
        self.system_prev = reading
        self.system_prev_t = now
        self.system_totals = (reading[0] - self.system_base[0], reading[1] - self.system_base[1])

    def set_machine(
        self, cpu: Optional[CpuTicks], mem_used: Optional[int], mem_total: Optional[int], latency_ms: Optional[float]
    ) -> None:
        """The whole Mac at an emit: its CPU ticks (a share needs two
        readings), its memory in use and RAM, and the latest probe's latency."""
        if cpu is None:
            self.cpu_prev = None
            self.cpu_pct = None
        elif self.cpu_prev is None:
            self.cpu_prev = cpu
        else:
            pct = cpu_busy_pct(self.cpu_prev, cpu)
            if pct is not None:  # else no tick passed: measure over a longer span
                self.cpu_pct = pct
                self.cpu_prev = cpu
        self.mem_used = mem_used
        self.mem_total = mem_total
        self.latency_ms = latency_ms

    def system_json(self) -> Dict[str, float]:
        """The whole Mac's figures; one not known yet is left out."""
        record: Dict[str, float] = {
            "netInBps": round(self.system_rates[0], 1),
            "netOutBps": round(self.system_rates[1], 1),
            "netIn": self.system_totals[0],
            "netOut": self.system_totals[1],
        }
        if self.cpu_pct is not None:
            record["cpuPct"] = round(self.cpu_pct, 1)
        if self.mem_used is not None:
            record["memUsed"] = self.mem_used
        if self.mem_total is not None:
            record["memTotal"] = self.mem_total
        if self.latency_ms is not None:
            record["latencyMs"] = round(self.latency_ms, 1)
        return record

    def emit(self, now: float) -> Dict[str, object]:
        groups = [
            self._group_json(g, now) for g in self.groups.values() if g.ended_at is None
        ]
        ended = [self._group_json(g, now) for g in self.ended]
        for g in self.ended:
            self.groups.pop(g.id, None)
        self.ended = []
        session = self.session_totals()
        session_rates = self.rates(session, self.session_prev, now - self.session_prev_t)
        self.session_prev = session
        self.session_prev_t = now
        reaped = self.reaped_unclaimed_cpu
        self.reaped_unclaimed_cpu = 0.0
        mem = sum(p.mem for p in self.procs.values()) + (self.root_proc.mem if self.root_proc else 0)
        return {
            "type": "tick",
            "t": round(now, 3),
            "groups": groups,
            "ended": ended,
            "session": dict(session.as_json(), mem=mem, **session_rates),
            "reaped": {"cpuS": round(reaped, 4), "energyEstJ": round(reaped * self.j_per_cpu_s, 4)},
            "system": self.system_json(),
            "jPerCpuS": round(self.j_per_cpu_s, 4),
        }


# --------------------------------------------------------------------------- #
# The OS layer (macOS)
# --------------------------------------------------------------------------- #


class VmStatistics64(ctypes.Structure):
    """<mach/vm_statistics.h> struct vm_statistics64, as HOST_VM_INFO64 fills it."""

    _fields_ = [
        ("free_count", ctypes.c_uint32),
        ("active_count", ctypes.c_uint32),
        ("inactive_count", ctypes.c_uint32),
        ("wire_count", ctypes.c_uint32),
        ("zero_fill_count", ctypes.c_uint64),
        ("reactivations", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("pageouts", ctypes.c_uint64),
        ("faults", ctypes.c_uint64),
        ("cow_faults", ctypes.c_uint64),
        ("lookups", ctypes.c_uint64),
        ("hits", ctypes.c_uint64),
        ("purges", ctypes.c_uint64),
        ("purgeable_count", ctypes.c_uint32),
        ("speculative_count", ctypes.c_uint32),
        ("decompressions", ctypes.c_uint64),
        ("compressions", ctypes.c_uint64),
        ("swapins", ctypes.c_uint64),
        ("swapouts", ctypes.c_uint64),
        ("compressor_page_count", ctypes.c_uint32),
        ("throttled_count", ctypes.c_uint32),
        ("external_page_count", ctypes.c_uint32),
        ("internal_page_count", ctypes.c_uint32),
        ("total_uncompressed_pages_in_compressor", ctypes.c_uint64),
    ]
    # The fields read, typed (ctypes makes every field from _fields_ above).
    internal_page_count: int
    purgeable_count: int
    wire_count: int
    compressor_page_count: int


class Mac:
    RUSAGE_INFO_V6 = 6
    SLOTS = 80
    HOST_CPU_LOAD_INFO = 3
    HOST_VM_INFO64 = 4
    CPU_STATES = 4  # user, system, idle, nice

    def __init__(self) -> None:
        self.libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

        tb = Timebase()
        self.libc.mach_timebase_info(ctypes.byref(tb))
        self.ns_per_tick = tb.numer / tb.denom
        self.libc.mach_absolute_time.restype = ctypes.c_uint64
        self.buf = (ctypes.c_uint64 * self.SLOTS)()
        self.pids = (ctypes.c_int * 4096)()
        # The whole machine: one host port for the session, buffers reused each emit.
        self.libc.mach_host_self.argtypes = []
        self.libc.mach_host_self.restype = ctypes.c_uint32
        for function in (self.libc.host_statistics, self.libc.host_statistics64):
            function.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
            function.restype = ctypes.c_int
        self.libc.host_page_size.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_size_t)]
        self.libc.host_page_size.restype = ctypes.c_int
        self.libc.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        self.libc.sysctlbyname.restype = ctypes.c_int
        self.host = int(self.libc.mach_host_self())
        self.cpu_info = (ctypes.c_uint32 * self.CPU_STATES)()
        self.vm_info = VmStatistics64()
        self.page_size = self._page_size()
        self.mem_total = self._mem_total()

    def mach_now(self) -> int:
        return int(self.libc.mach_absolute_time())

    def _page_size(self) -> Optional[int]:
        """The kernel's page size, the unit of the host's page counts (16 KB on Apple silicon)."""
        size = ctypes.c_size_t(0)
        if self.libc.host_page_size(self.host, ctypes.byref(size)) != 0 or size.value <= 0:
            return None
        return int(size.value)

    def _mem_total(self) -> Optional[int]:
        """The Mac's RAM in bytes: sysctl hw.memsize."""
        value = ctypes.c_uint64(0)
        size = ctypes.c_size_t(ctypes.sizeof(value))
        if self.libc.sysctlbyname(b"hw.memsize", ctypes.byref(value), ctypes.byref(size), None, 0) != 0 or value.value <= 0:
            return None
        return int(value.value)

    def cpu_ticks(self) -> Optional[CpuTicks]:
        """The machine's CPU ticks since boot, every core summed: one Mach call."""
        count = ctypes.c_uint32(self.CPU_STATES)
        if self.libc.host_statistics(self.host, self.HOST_CPU_LOAD_INFO, self.cpu_info, ctypes.byref(count)) != 0:
            return None
        info = self.cpu_info
        return CpuTicks(user=int(info[0]), system=int(info[1]), idle=int(info[2]), nice=int(info[3]))

    def memory_used(self) -> Optional[int]:
        """Activity Monitor's Memory Used in bytes, from the host's page counts: one Mach call."""
        if self.page_size is None:
            return None
        count = ctypes.c_uint32(ctypes.sizeof(VmStatistics64) // ctypes.sizeof(ctypes.c_uint32))
        if self.libc.host_statistics64(self.host, self.HOST_VM_INFO64, ctypes.byref(self.vm_info), ctypes.byref(count)) != 0:
            return None
        vm = self.vm_info
        pages = VmPages(
            internal=vm.internal_page_count,
            purgeable=vm.purgeable_count,
            wired=vm.wire_count,
            compressor=vm.compressor_page_count,
        )
        return memory_used(pages, self.page_size)

    def children(self, pid: int) -> List[int]:
        n = self.libc.proc_listchildpids(pid, self.pids, ctypes.sizeof(self.pids))
        if n <= 0:
            return []
        return [p for p in self.pids[: min(n, 4096)] if p > 0]

    def parent(self, pid: int) -> Optional[int]:
        try:
            out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip())
        except (ValueError, OSError, subprocess.SubprocessError):
            return None

    def rusage(self, pid: int, ppid: int, now_wall: float, now_mach: int) -> Optional[Proc]:
        if self.libc.proc_pid_rusage(pid, self.RUSAGE_INFO_V6, ctypes.byref(self.buf)) != 0:
            return None
        v = self.buf
        tick_s = self.ns_per_tick / 1e9
        start = int(v[10])
        return Proc(
            pid=pid,
            ppid=ppid,
            start=start,
            started_at=now_wall - max(0, now_mach - start) * tick_s,
            own_cpu=(v[2] + v[3]) * tick_s,
            child_cpu=(v[12] + v[13]) * tick_s,
            energy_j=v[42] / 1e9,
            mem=int(v[9]),
            peak_mem=int(v[30]),
            disk_r=int(v[18]),
            disk_w=int(v[19]),
        )

    def argv(self, pid: int) -> List[str]:
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t(0)
        if self.libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value == 0:
            return []
        raw_buf = ctypes.create_string_buffer(size.value)
        if self.libc.sysctl(mib, 3, raw_buf, ctypes.byref(size), None, 0) != 0:
            return []
        raw = raw_buf.raw[: size.value]
        if len(raw) < 4:
            return []
        argc = struct.unpack("i", raw[:4])[0]
        rest = raw[4:]
        cut = rest.find(b"\0")
        if cut < 0:
            return []
        rest = rest[cut:].lstrip(b"\0")
        return [part.decode("utf-8", "replace") for part in rest.split(b"\0")[:argc]]

    def comm(self, pid: int) -> str:
        args = self.argv(pid)
        return os.path.basename(args[0]) if args else ""

    @staticmethod
    def nettop() -> Optional[Dict[int, Tuple[int, int]]]:
        try:
            out = subprocess.run(
                ["nettop", "-P", "-L", "1", "-x", "-n", "-J", "bytes_in,bytes_out"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return parse_nettop(out.stdout)
        except (OSError, subprocess.SubprocessError):
            return None

    @staticmethod
    def interfaces() -> Optional[Tuple[int, int]]:
        try:
            out = subprocess.run(["netstat", "-ib", "-n"], capture_output=True, text=True, timeout=5)
            return parse_netstat(out.stdout)
        except (OSError, subprocess.SubprocessError):
            return None


# --------------------------------------------------------------------------- #
# The latency probe
# --------------------------------------------------------------------------- #


def tcp_connect_ms(host: str, port: int, timeout_s: float) -> Optional[float]:
    """How long a TCP connect to host:port takes, in ms: the name is looked up
    first and not timed, and the socket closes at once. None when it fails."""
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None
    for family, kind, proto, _, address in addresses[:PROBE_ADDRESSES]:
        try:
            sock = socket.socket(family, kind, proto)
        except OSError:
            continue
        with sock:
            sock.settimeout(timeout_s)
            start = time.perf_counter()
            try:
                sock.connect(address)
            except OSError:
                continue
            return (time.perf_counter() - start) * 1000
    return None


class LatencyProbe:
    """Measures on a thread of its own, every `every_s`, so a slow or hanging
    network never holds up a tick; the sampling loop reads the latest."""

    def __init__(self, measure: Callable[[], Optional[float]], every_s: float, stale_s: float) -> None:
        self.measure = measure
        self.every_s = every_s
        self.stale_s = stale_s
        self.latest: Optional[Tuple[float, float]] = None  # (ms, time.monotonic() when taken)
        self.stopped = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, name="latency-probe", daemon=True).start()

    def stop(self) -> None:
        self.stopped.set()

    def _run(self) -> None:
        while not self.stopped.is_set():
            ms = self.measure()
            self.latest = None if ms is None else (ms, time.monotonic())
            self.stopped.wait(self.every_s)

    def value(self) -> Optional[float]:
        """The latest probe's ms; None before the first, after a failed one, or once it is stale."""
        return fresh_latency(self.latest, time.monotonic(), self.stale_s)


def find_root(mac: Mac, start: int) -> int:
    """The Claude Code process above this sampler: the nearest ancestor named claude."""
    cursor: Optional[int] = start
    for _ in range(8):
        if cursor is None or cursor <= 1:
            break
        args = mac.argv(cursor)
        if any(
            os.path.basename(arg) == "claude" or "/claude.app/" in arg or "/claude-code/" in arg for arg in args[:2]
        ):
            return cursor
        cursor = mac.parent(cursor)
    return start


def snapshot(mac: Mac, root: int) -> List[Proc]:
    now_wall = time.time()
    now_mach = mac.mach_now()
    result: List[Proc] = []
    stack: List[Tuple[int, int]] = [(root, 0)]
    seen = set()
    while stack and len(seen) < 2000:
        pid, ppid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        proc = mac.rusage(pid, ppid, now_wall, now_mach)
        if proc is not None:
            result.append(proc)
        for child in mac.children(pid):
            stack.append((child, pid))
    return result


def main() -> int:
    if sys.platform != "darwin":
        print(json.dumps({"type": "error", "message": "The sampler reads macOS process counters only."}), flush=True)
        return 1
    mac = Mac()
    me = os.getpid()
    root = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else find_root(mac, os.getppid())
    tracker = Tracker(root=root, me=me, ncpu=os.cpu_count() or 1)
    argv_cache: Dict[str, List[str]] = {}
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(
        json.dumps({"type": "hello", "root": root, "self": me, "ncpu": tracker.ncpu, "t": round(time.time(), 3)}),
        flush=True,
    )
    probe = LatencyProbe(lambda: tcp_connect_ms(LATENCY_HOST, LATENCY_PORT, PROBE_TIMEOUT_S), PROBE_EVERY_S, PROBE_STALE_S)
    probe.start()
    next_emit = 0.0
    last_full = 0.0
    last_net = 0.0
    known_children: set = set()
    while True:
        if os.getppid() == 1:
            return 0
        now = time.time()
        # One syscall a tick; the full walk runs while a command is live, when
        # the root's children change (a command starts or ends), and to emit.
        children = set(mac.children(root))
        busy = any(g.kind == "bash" and g.ended_at is None for g in tracker.groups.values())
        is_emit = now >= next_emit
        if busy or is_emit or children != known_children or now - last_full >= IDLE_TICK_S:
            known_children = children
            last_full = now
            live = snapshot(mac, root)
            if not any(p.pid == root for p in live):
                print(json.dumps({"type": "error", "message": f"Claude process {root} is gone."}), flush=True)
                return 0
            for p in live:
                if p.key not in argv_cache and p.ppid == root:
                    argv_cache[p.key] = mac.argv(p.pid)
            # Network every emit, and twice a second while a command runs, so a
            # download's last bytes before its process exits are mostly counted.
            wants_net = is_emit or (busy and now - last_net >= BUSY_NET_S)
            if wants_net:
                last_net = now
            tracker.update(live, argv_cache, mac.nettop() if wants_net else None, now)
            if is_emit or tracker.ended:
                tracker.set_system(mac.interfaces() if is_emit else None, now)
                if is_emit:
                    # Two Mach calls and a read of the probe's latest: microseconds.
                    tracker.set_machine(mac.cpu_ticks(), mac.memory_used(), mac.mem_total, probe.value())
                try:
                    print(json.dumps(tracker.emit(now), separators=(",", ":")), flush=True)
                except BrokenPipeError:
                    return 0
                if is_emit:
                    next_emit = now + EMIT_EVERY_S
            live_keys = {p.key for p in live}
            for key in list(argv_cache):
                if key not in live_keys:
                    del argv_cache[key]
        time.sleep(FAST_TICK_S)


if __name__ == "__main__":
    sys.exit(main())
