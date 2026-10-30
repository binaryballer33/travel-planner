#!/usr/bin/env python3
"""Session Monitor: the Ports tab's helper.

Each run prints one JSON object on stdout:

  procs.py snapshot [--dev 8133,8134] [--tail 8133] [--watch 4242]
      Every Claude Code session on this Mac with its process tree, every TCP
      listener, and the dev servers on the given ports (with the last lines of
      their logs for --tail, and how many processes remain in each --watch
      process group).
  procs.py signal STOP|CONT|TERM|KILL <pid> <startedAtMs>
      Signals one process after checking, right before, that it is still the
      same process (its start time), is the user's own, and is neither this
      session's Claude process (nor anything above it) nor the monitor's own
      helper.
  procs.py launch <port> <cwd> <command>
      Starts a dev server detached, in a session and process group of its own,
      so it outlives the pane, the plugin and the session; its output is
      appended to ~/.claude/session-monitor/logs/<port>.log.
  procs.py stop <port> [timeout_s]
      SIGTERM to the listener's process group (or, when that group holds a
      Claude process, to the listener and its descendants only), SIGKILL to
      whatever remains after the timeout, then confirms the port is free.

Standard library only (Python 3.9). On macOS processes come from `ps`, listeners
and working directories from `lsof`. On Windows (class WindowsSystem) they come
from kernel32 and ntdll through ctypes and listeners from `netstat -ano`; Windows
has no process groups, so a server is stopped as its listener and descendants.
Command lines are never printed: a process is shown by a short name with
anything that looks like a secret left out.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, replace
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(os.path.expanduser("~"), ".claude", "session-monitor", "logs")
IS_WINDOWS = sys.platform == "win32"
#: Windows has no SIGSTOP, SIGCONT or SIGKILL: the numbers are only names for what WindowsSystem.kill does.
SIGNALS: Dict[str, int] = {
    "STOP": int(getattr(signal, "SIGSTOP", 19)),
    "CONT": int(getattr(signal, "SIGCONT", 18)),
    "TERM": int(signal.SIGTERM),
    "KILL": int(getattr(signal, "SIGKILL", 9)),
}
#: How far apart two readings of one process's start time may be (ps reports
#: elapsed time in whole seconds) and still be the same process.
START_SLACK_MS = 3_000
MAX_SESSIONS = 24
MAX_NODES = 60
LOG_LINES = 40
LOG_TAIL_BYTES = 24_000
LOG_ROTATE_BYTES = 4_000_000
SHELLS = {"sh", "bash", "zsh", "dash", "fish"}
SHELL_MARK = "shell-snapshots/snapshot-"
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "~/.bun/bin", "~/.local/bin", "~/.cargo/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

EXTRA_PATH_WINDOWS = ["~\\.bun\\bin", "~\\.cargo\\bin", "~\\.local\\bin", "~\\AppData\\Roaming\\npm"]

SECRET_ARG = re.compile(
    r"([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=\S+",
    re.IGNORECASE,
)
SECRET_FLAG = re.compile(r"^--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|credential)", re.IGNORECASE)
SECRET_SHAPE = re.compile(r"^(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abpr]-|AKIA|eyJ)|^[A-Za-z0-9_\-+=]{32,}$")
BEARER = re.compile(r"\b(Bearer|Basic|token)\s+\S+", re.IGNORECASE)
URL_CREDS = re.compile(r"(://)[^/@\s:]+:[^/@\s]+@")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
MONITOR_SCRIPT = re.compile(r"session-monitor/(?:[^/\s]+/)?sampler/(?:sampler|procs)\.py")


# --------------------------------------------------------------------------- #
# Redaction and names
# --------------------------------------------------------------------------- #


def slashes(text: str) -> str:
    """Windows paths with forward slashes, so one pattern reads both kinds."""
    return text.replace("\\", "/")


def is_abs(path: str) -> bool:
    return path.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", path) is not None or path.startswith("\\\\")


def base_name(path: str) -> str:
    """A program's name: its file name without folders, and without a Windows `.exe`."""
    name = os.path.basename(slashes(path).rstrip("/"))
    return name[:-4] if name.lower().endswith(".exe") else name


def printable(text: str) -> str:
    """Text without escape sequences or control characters."""
    return "".join(ch for ch in ANSI.sub("", text) if ch.isprintable())


def redact(text: str) -> str:
    """Masks credentials: KEY=value arguments, `Bearer x`, user:pass@ in URLs."""
    masked = SECRET_ARG.sub(lambda m: f"{m.group(1)}=***", text)
    masked = BEARER.sub(lambda m: f"{m.group(1)} ***", masked)
    return URL_CREDS.sub(r"\1***@", masked)


def looks_secret(token: str) -> bool:
    return bool(SECRET_SHAPE.match(token))


def scrub(text: str) -> str:
    """A command line safe to show: credentials masked, secret-shaped words replaced."""
    words = [("***" if looks_secret(word) else word) for word in redact(printable(text)).split()]
    return " ".join(words)


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


def tool_shell_command(args: str) -> Optional[str]:
    """The command a Claude Code Bash tool shell runs: the word after `eval `."""
    if SHELL_MARK not in slashes(args):
        return None
    at = args.rfind(" && eval ")
    if at < 0:
        return None
    return read_shell_word(args, at + len(" && eval "))


def short_name(exe: str, args: str) -> str:
    """A short, secret-free name: the program and up to three of its words."""
    if is_abs(exe):
        head = base_name(exe)
        rest = args.split()
    else:
        parts = exe.split()
        head = base_name(parts[0]) if parts else ""
        rest = parts[1:] + args.split()
    if head.lower() in SHELLS:
        command = tool_shell_command(args)
        if command is not None:
            return f"$ {scrub(command)}"[:60]
    words = [printable(head)] if head else []
    skip_next = False
    for token in rest:
        if len(words) >= 4:
            break
        if skip_next:
            skip_next = False
            continue
        if token.startswith("-"):
            flag = token.split("=", 1)[0]
            if "=" not in token and (flag in ("-c", "-e", "--eval") or SECRET_FLAG.match(flag)):
                skip_next = True
            continue
        if "://" in token:
            token = URL_CREDS.sub(r"\1", token).split("?", 1)[0].split("#", 1)[0]
        elif "=" in token:
            continue
        elif is_abs(token) or token.startswith("~"):
            token = base_name(token) or token
        if looks_secret(token):
            continue
        words.append(printable(token))
    return redact(" ".join(word for word in words if word))[:60] or "process"


# --------------------------------------------------------------------------- #
# Parsing ps and lsof
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Row:
    """One process. `exe` is argv[0] as ps prints it; `args` the rest, never printed."""

    pid: int
    ppid: int
    pgid: int
    uid: int
    stat: str
    started_ms: int
    cpu_pct: float
    mem_bytes: int
    exe: str
    args: str

    @property
    def state(self) -> str:
        letter = self.stat[:1]
        return "suspended" if letter == "T" else "zombie" if letter == "Z" else "running"

    @property
    def text(self) -> str:
        return f"{self.exe} {self.args}"


@dataclass(frozen=True)
class Listener:
    pid: int
    port: int
    address: str
    command: str
    uid: int


def parse_etime(text: str) -> Optional[int]:
    """`[[dd-]hh:]mm:ss` -> seconds."""
    days = 0
    rest = text.strip()
    if "-" in rest:
        day_text, rest = rest.split("-", 1)
        if not day_text.isdigit():
            return None
        days = int(day_text)
    parts = rest.split(":")
    if not 2 <= len(parts) <= 3 or not all(part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return days * 86_400 + seconds


def parse_ps(stats: str, commands: str, now_ms: int) -> Dict[int, Row]:
    """`ps -o pid=,ppid=,pgid=,uid=,stat=,etime=,%cpu=,rss=,comm=` and `ps -o pid=,command=`."""
    full: Dict[int, str] = {}
    for line in commands.splitlines():
        cols = line.strip().split(None, 1)
        if cols and cols[0].isdigit():
            full[int(cols[0])] = cols[1] if len(cols) > 1 else ""
    rows: Dict[int, Row] = {}
    for line in stats.splitlines():
        cols = line.strip().split(None, 8)
        if len(cols) < 9 or not cols[0].isdigit():
            continue
        try:
            pid, ppid, pgid, uid = int(cols[0]), int(cols[1]), int(cols[2]), int(cols[3])
            cpu = float(cols[6].replace(",", "."))
            rss_kb = int(cols[7])
        except ValueError:
            continue
        elapsed = parse_etime(cols[5])
        if elapsed is None:
            continue
        exe = cols[8].strip()
        command = full.get(pid, exe)
        args = command[len(exe) :].strip() if command.startswith(exe) else command.split(None, 1)[1] if " " in command else ""
        rows[pid] = Row(
            pid=pid,
            ppid=ppid,
            pgid=pgid,
            uid=uid,
            stat=cols[4],
            started_ms=now_ms - elapsed * 1000,
            cpu_pct=cpu,
            mem_bytes=rss_kb * 1024,
            exe=exe,
            args=args,
        )
    return rows


def parse_listeners(text: str) -> List[Listener]:
    """`lsof -nP -iTCP -sTCP:LISTEN -F pcnu` -> one listener per process and port."""
    found: Dict[Tuple[int, int], Listener] = {}
    pid = -1
    command = ""
    uid = -1
    for line in text.splitlines():
        if not line:
            continue
        tag, value = line[0], line[1:]
        if tag == "p":
            pid = int(value) if value.isdigit() else -1
            command = ""
            uid = -1
        elif tag == "c":
            command = printable(value)[:60]
        elif tag == "u":
            uid = int(value) if value.isdigit() else -1
        elif tag == "n" and pid > 0:
            address, sep, port_text = value.rpartition(":")
            if not sep or not port_text.isdigit():
                continue
            key = (pid, int(port_text))
            address = address or "*"
            known = found.get(key)
            if known is None:
                found[key] = Listener(pid=pid, port=int(port_text), address=address, command=command, uid=uid)
            elif address not in known.address.split(" "):
                found[key] = Listener(pid=pid, port=known.port, address=f"{known.address} {address}", command=known.command, uid=known.uid)
    return sorted(found.values(), key=lambda one: (one.port, one.pid))


def parse_cwds(text: str) -> Dict[int, str]:
    """`lsof -a -d cwd -p <pids> -Fn` -> {pid: working directory}."""
    result: Dict[int, str] = {}
    pid = -1
    for line in text.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid > 0:
            result[pid] = printable(line[1:])
    return result


# --------------------------------------------------------------------------- #
# The process tree
# --------------------------------------------------------------------------- #


def is_claude(row: Row) -> bool:
    """A Claude Code process: its program is `claude`, or Claude Code's own build."""
    exe = slashes(row.exe)
    head = row.exe if is_abs(row.exe) else (row.exe.split() or [""])[0]
    base = base_name(head).lower()
    if base == "claude" or "/claude.app/" in exe or "/claude-code/" in exe:
        return True
    if base in ("node", "bun"):
        first = slashes((row.args.split() or [""])[0])
        return "/claude-code/" in first or base_name(first).lower() == "claude"
    return False


def is_monitor(row: Row, here: str = HERE) -> bool:
    """The monitor's own helpers: this folder's sampler and this script."""
    text = slashes(row.text)
    return f"{slashes(here)}/" in text or bool(MONITOR_SCRIPT.search(text))


def ancestors(rows: Dict[int, Row], pid: int) -> List[int]:
    """The parent chain above `pid`, nearest first, as far as `ps` knows it."""
    chain: List[int] = []
    row = rows.get(pid)
    while row is not None and row.ppid > 1 and row.ppid not in chain and len(chain) < 64:
        chain.append(row.ppid)
        row = rows.get(row.ppid)
    return chain


def children_of(rows: Dict[int, Row]) -> Dict[int, List[int]]:
    result: Dict[int, List[int]] = {}
    for row in rows.values():
        if row.ppid != row.pid:
            result.setdefault(row.ppid, []).append(row.pid)
    for pids in result.values():
        pids.sort()
    return result


def descendants(rows: Dict[int, Row], pid: int) -> List[int]:
    kids = children_of(rows)
    out: List[int] = []
    stack = list(reversed(kids.get(pid, [])))
    while stack and len(out) < 5_000:
        current = stack.pop()
        if current in out:
            continue
        out.append(current)
        stack.extend(reversed(kids.get(current, [])))
    return out


def tree(rows: Dict[int, Row], root: int, skip: Set[int], limit: int = MAX_NODES) -> List[Tuple[int, int]]:
    """(pid, depth) below `root`, depth first; `skip` and everything below it left out."""
    kids = children_of(rows)
    out: List[Tuple[int, int]] = []
    stack: List[Tuple[int, int]] = [(child, 1) for child in reversed(kids.get(root, []))]
    seen: Set[int] = set()
    while stack and len(out) < limit:
        pid, depth = stack.pop()
        if pid in seen or pid in skip:
            continue
        seen.add(pid)
        out.append((pid, depth))
        stack.extend((child, depth + 1) for child in reversed(kids.get(pid, [])))
    return out


def session_roots(rows: Dict[int, Row]) -> List[int]:
    """Each Claude Code process with no Claude Code process above it."""
    claude = {pid for pid, row in rows.items() if is_claude(row)}
    return sorted(pid for pid in claude if not any(up in claude for up in ancestors(rows, pid)))


def this_session(rows: Dict[int, Row], me: int) -> Optional[int]:
    """The session root above this helper: the topmost Claude process of its parent chain."""
    found: Optional[int] = None
    for pid in ancestors(rows, me):
        row = rows.get(pid)
        if row is not None and is_claude(row):
            found = pid
    return found


@dataclass
class Context:
    """Who is asking: this helper's pid, the user's uid, and the monitor's folder."""

    me: int
    uid: int
    here: str = HERE


def protected_pids(rows: Dict[int, Row], ctx: Context) -> Set[int]:
    """Never signalled: this helper and what it runs, everything above it (this
    session's Claude process among them), and the monitor's own helpers."""
    guarded = {ctx.me, *descendants(rows, ctx.me), *ancestors(rows, ctx.me)}
    guarded.update(pid for pid, row in rows.items() if is_monitor(row, ctx.here) or pid <= 1)
    return guarded


def refusal(rows: Dict[int, Row], pid: int, ctx: Context, guarded: Set[int]) -> Optional[str]:
    """Why `pid` may not be signalled, or None."""
    row = rows.get(pid)
    if pid <= 1:
        return "pid 1 and below belong to the system"
    if row is None:
        return f"process {pid} is no longer running"
    if row.uid != ctx.uid:
        return f"process {pid} belongs to another user (uid {row.uid})"
    if pid in guarded:
        if is_monitor(row, ctx.here) or pid == ctx.me:
            return "it is the Session Monitor's own helper"
        if is_claude(row):
            return "it is this session's own Claude process"
        return "it runs this session (it is above this session's Claude process)"
    return None


def group_is_safe(rows: Dict[int, Row], pgid: int, ctx: Context, guarded: Set[int]) -> bool:
    """A process group that may be signalled whole: the user's own, no Claude
    process in it, nothing guarded in it."""
    if pgid <= 1:
        return False
    members = [row for row in rows.values() if row.pgid == pgid]
    return bool(members) and all(row.uid == ctx.uid and row.pid not in guarded and not is_claude(row) for row in members)


# --------------------------------------------------------------------------- #
# The snapshot
# --------------------------------------------------------------------------- #


def node_json(row: Row, depth: int, ports: List[int], ctx: Context) -> Dict[str, object]:
    return {
        "pid": row.pid,
        "ppid": row.ppid,
        "pgid": row.pgid,
        "uid": row.uid,
        "name": "Claude Code" if is_claude(row) else short_name(row.exe, row.args),
        "state": row.state,
        "cpuPct": round(row.cpu_pct, 1),
        "memBytes": row.mem_bytes,
        "startedAt": row.started_ms,
        "ports": ports,
        "depth": depth,
        "isMonitor": is_monitor(row, ctx.here),
    }


def read_tail(path: str, max_bytes: int = LOG_TAIL_BYTES, max_lines: int = LOG_LINES) -> List[str]:
    """The last lines of a log, escape codes and credentials removed."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            handle.seek(max(0, size - max_bytes))
            data = handle.read()
    except OSError:
        return []
    text = data.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    if size > max_bytes:
        text = text.split("\n", 1)[-1]
    lines = [redact(printable(line))[:400] for line in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return lines[-max_lines:]


def build_snapshot(
    rows: Dict[int, Row],
    listeners: List[Listener],
    cwds: Dict[int, str],
    dev_ports: Sequence[int],
    ctx: Context,
    now_ms: int,
    logs: Optional[Dict[int, List[str]]] = None,
    watch: Sequence[int] = (),
) -> Dict[str, object]:
    guarded = protected_pids(rows, ctx)
    mine = this_session(rows, ctx.me)
    skip = {ctx.me, *descendants(rows, ctx.me)}
    ports_of: Dict[int, List[int]] = {}
    for listener in listeners:
        ports_of.setdefault(listener.pid, [])
        if listener.port not in ports_of[listener.pid]:
            ports_of[listener.pid].append(listener.port)
    roots = session_roots(rows)
    roots.sort(key=lambda pid: (pid != mine, -rows[pid].started_ms))
    sessions: List[Dict[str, object]] = []
    session_of: Dict[int, int] = {}
    for root in roots[:MAX_SESSIONS]:
        row = rows[root]
        session_of[root] = root
        nodes: List[Dict[str, object]] = []
        for pid, depth in tree(rows, root, skip):
            session_of[pid] = root
            nodes.append(node_json(rows[pid], depth, ports_of.get(pid, []), ctx))
        session = node_json(row, 0, ports_of.get(root, []), ctx)
        session.update({"cwd": cwds.get(root, ""), "isThis": root == mine, "children": nodes})
        sessions.append(session)
    dev = set(dev_ports)
    listener_json: List[Dict[str, object]] = []
    for listener in listeners:
        row = rows.get(listener.pid)
        owner = "dev" if listener.port in dev else "claude" if listener.pid in session_of else "other"
        name = (
            ("Claude Code" if is_claude(row) else short_name(row.exe, row.args))
            if row is not None and owner != "other"
            else listener.command or (os.path.basename(row.exe) if row is not None else "?")
        )
        entry: Dict[str, object] = {
            "port": listener.port,
            "address": listener.address,
            "pid": listener.pid,
            "name": printable(name)[:60],
            "uid": listener.uid if listener.uid >= 0 else (row.uid if row is not None else -1),
            "owner": owner,
            "startedAt": row.started_ms if row is not None else 0,
            "state": row.state if row is not None else "running",
            "isMonitor": row is not None and is_monitor(row, ctx.here),
        }
        if listener.pid in session_of:
            entry["sessionPid"] = session_of[listener.pid]
        listener_json.append(entry)
    servers: List[Dict[str, object]] = []
    for port in dev_ports:
        pids = sorted({one.pid for one in listeners if one.port == port and one.pid in rows})
        if not pids:
            continue
        first = rows[pids[0]]
        is_safe = group_is_safe(rows, first.pgid, ctx, guarded)
        members = (
            [row for row in rows.values() if row.pgid == first.pgid]
            if is_safe
            else [rows[pid] for pid in [first.pid, *descendants(rows, first.pid)] if pid in rows]
        )
        servers.append(
            {
                "port": port,
                "pids": pids,
                "pgid": first.pgid,
                "name": short_name(first.exe, first.args),
                "startedAt": min(row.started_ms for row in members),
                "cpuPct": round(sum(row.cpu_pct for row in members), 1),
                "memBytes": sum(row.mem_bytes for row in members),
                "procs": len(members),
                "cwd": cwds.get(first.pid, ""),
                "isGroupSafe": is_safe,
            }
        )
    return {
        "ok": True,
        "t": now_ms,
        "uid": ctx.uid,
        "home": os.path.expanduser("~"),
        "logDir": LOG_DIR,
        "sessions": sessions,
        "listeners": listener_json,
        "devServers": servers,
        "logs": [{"port": port, "lines": lines} for port, lines in sorted((logs or {}).items())],
        "groups": [{"pgid": pgid, "alive": sum(1 for row in rows.values() if row.pgid == pgid and row.state != "zombie")} for pgid in watch],
    }


# --------------------------------------------------------------------------- #
# The system, behind one seam so the actions can be tested without signals
# --------------------------------------------------------------------------- #


class System:
    """The real machine: ps, lsof, kill, sleep and spawning a detached server."""

    def now_ms(self) -> int:
        return int(time.time() * 1000)

    def run(self, argv: List[str]) -> str:
        env = dict(os.environ)
        env["LC_ALL"] = "C"
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=10, env=env, errors="replace").stdout
        except (OSError, subprocess.SubprocessError):
            return ""

    def ps(self) -> Dict[int, Row]:
        stats = self.run(["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,uid=,stat=,etime=,%cpu=,rss=,comm="])
        commands = self.run(["ps", "-A", "-ww", "-o", "pid=,command="])
        if stats.strip() == "":
            raise RuntimeError("ps printed nothing")
        return parse_ps(stats, commands, self.now_ms())

    def listeners(self) -> List[Listener]:
        return parse_listeners(self.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnu"]))

    def cwds(self, pids: Iterable[int]) -> Dict[int, str]:
        wanted = sorted(set(pids))
        if not wanted:
            return {}
        return parse_cwds(self.run(["lsof", "-a", "-d", "cwd", "-p", ",".join(str(pid) for pid in wanted), "-Fn"]))

    def kill(self, pid: int, sig: int) -> None:
        os.kill(pid, sig)

    def killpg(self, pgid: int, sig: int) -> None:
        os.killpg(pgid, sig)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def spawn(self, argv: List[str], cwd: str, env: Dict[str, str], log_fd: int) -> int:
        child = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
        return child.pid


class FileTime(ctypes.Structure):
    _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]


class ProcessEntry32(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_int32),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class MemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_uint32),
        ("PageFaultCount", ctypes.c_uint32),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


#: Access rights: PROCESS_TERMINATE, PROCESS_SUSPEND_RESUME, PROCESS_QUERY_LIMITED_INFORMATION,
#: PROCESS_QUERY_INFORMATION and PROCESS_VM_READ.
ACCESS_TERMINATE = 0x0001
ACCESS_SUSPEND_RESUME = 0x0800
ACCESS_QUERY_LIMITED = 0x1000
ACCESS_QUERY = 0x0400
ACCESS_VM_READ = 0x0010
ERROR_INVALID_PARAMETER = 87  # OpenProcess on a pid that no longer exists
FILETIME_UNIX_EPOCH = 116444736000000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
STATE_FILE = os.path.join(os.path.dirname(LOG_DIR), "procs-state.json")


def filetime_int(ft: FileTime) -> int:
    return (ft.hi << 32) | ft.lo


def parse_netstat_listeners(text: str) -> List[Listener]:
    """`netstat -ano -p TCP` -> one listener per process and port. A listener is a
    row whose remote side is the wildcard (`0.0.0.0:0` or `[::]:0`), so the
    state's wording (it is translated) never matters."""
    found: Dict[Tuple[int, int], Listener] = {}
    for line in text.splitlines():
        cols = line.split()
        if len(cols) != 5 or cols[0].upper() != "TCP" or not cols[4].isdigit():
            continue
        if cols[2] not in ("0.0.0.0:0", "[::]:0", "*:*"):
            continue
        host, sep, port_text = cols[1].rpartition(":")
        if not sep or not port_text.isdigit():
            continue
        pid, port = int(cols[4]), int(port_text)
        address = host.strip("[]") or "*"
        known = found.get((pid, port))
        if known is None:
            found[(pid, port)] = Listener(pid=pid, port=port, address=address, command="", uid=-1)
        elif address not in known.address.split(" "):
            found[(pid, port)] = Listener(pid=pid, port=port, address=f"{known.address} {address}", command="", uid=-1)
    return sorted(found.values(), key=lambda one: (one.port, one.pid))


class WindowsSystem(System):
    """The real machine on Windows: kernel32 and ntdll through ctypes, `netstat -ano` for listeners.

    Windows has no uids, so a process counts as the user's own when this helper
    may terminate and suspend it (uid 0), else it is another user's (uid 1). It
    has no process groups either: a row's pgid is the pid of the dev server this
    helper launched above it (recorded in procs-state.json), else 0, which
    `group_is_safe` refuses, so a server it did not start is stopped as its
    listener and its descendants. A suspended process is remembered in the same
    file, since Windows keeps no state letter to read it from.
    """

    def __init__(self) -> None:
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        self.ntdll = ctypes.WinDLL("ntdll")  # type: ignore[attr-defined]
        k = self.kernel32
        k.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        k.OpenProcess.restype = ctypes.c_void_p
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        k.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(FileTime)] * 4
        k.K32GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(MemoryCounters), ctypes.c_uint32]
        k.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
        k.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        k.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry32)]
        k.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry32)]
        k.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        self.ntdll.NtQueryInformationProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
        self.ntdll.NtQueryInformationProcess.restype = ctypes.c_int32
        self.ntdll.NtSuspendProcess.argtypes = [ctypes.c_void_p]
        self.ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]

    # -- the state file ----------------------------------------------------- #

    @staticmethod
    def _load() -> Dict[str, Dict[str, int]]:
        try:
            with open(STATE_FILE, encoding="utf-8") as handle:
                data = json.load(handle)
            return {"launched": dict(data.get("launched", {})), "suspended": dict(data.get("suspended", {}))}
        except (OSError, ValueError, AttributeError):
            return {"launched": {}, "suspended": {}}

    @staticmethod
    def _save(state: Dict[str, Dict[str, int]]) -> None:
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            with open(STATE_FILE, "w", encoding="utf-8") as handle:
                json.dump(state, handle)
        except OSError:
            pass

    # -- processes ---------------------------------------------------------- #

    def run(self, argv: List[str]) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=10, errors="replace", creationflags=CREATE_NO_WINDOW).stdout
        except (OSError, subprocess.SubprocessError):
            return ""

    def _open(self, pid: int, access: int) -> Optional[int]:
        handle = self.kernel32.OpenProcess(access, 0, pid)
        return int(handle) if handle else None

    def _toolhelp(self) -> List[Tuple[int, int, str]]:
        snap = self.kernel32.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
        if not snap or snap == ctypes.c_void_p(-1).value:
            return []
        found: List[Tuple[int, int, str]] = []
        entry = ProcessEntry32()
        entry.dwSize = ctypes.sizeof(ProcessEntry32)
        ok = self.kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            found.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID), entry.szExeFile))
            ok = self.kernel32.Process32NextW(snap, ctypes.byref(entry))
        self.kernel32.CloseHandle(snap)
        return found

    def _command_line(self, handle: int) -> str:
        size = 1024
        for _ in range(3):
            buf = ctypes.create_string_buffer(size)
            needed = ctypes.c_uint32(0)
            status = self.ntdll.NtQueryInformationProcess(handle, 60, buf, size, ctypes.byref(needed))  # ProcessCommandLineInformation
            if status == 0:
                length = int.from_bytes(buf.raw[0:2], "little")
                pointer = int.from_bytes(buf.raw[8:16] if ctypes.sizeof(ctypes.c_void_p) == 8 else buf.raw[4:8], "little")
                return ctypes.wstring_at(pointer, length // 2)
            if needed.value <= size:
                break
            size = int(needed.value)
        return ""

    def _row(self, pid: int, ppid: int, name: str, now_ms: int, suspended: Dict[str, int]) -> Row:
        handle = self._open(pid, ACCESS_QUERY_LIMITED | ACCESS_SUSPEND_RESUME | ACCESS_TERMINATE)
        is_mine = handle is not None
        if handle is None:
            handle = self._open(pid, ACCESS_QUERY_LIMITED)
        started_ms = 0
        cpu_pct = 0.0
        mem = 0
        exe = name
        args = ""
        if handle is not None:
            try:
                created, exited, kernel, user = FileTime(), FileTime(), FileTime(), FileTime()
                if self.kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                    started_ms = (filetime_int(created) - FILETIME_UNIX_EPOCH) // 10_000
                    elapsed_s = max(0.001, (now_ms - started_ms) / 1000)
                    cpu_pct = (filetime_int(kernel) + filetime_int(user)) / 1e7 / elapsed_s * 100
                counters = MemoryCounters()
                counters.cb = ctypes.sizeof(counters)
                if self.kernel32.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                    mem = int(counters.WorkingSetSize)
                line = self._command_line(handle).strip()
                if line:
                    if line.startswith('"') and line.count('"') >= 2:
                        end = line.index('"', 1)
                        exe, args = line[1:end], line[end + 1 :].strip()
                    else:
                        head, _, tail = line.partition(" ")
                        exe, args = head, tail.strip()
                else:
                    buf = ctypes.create_unicode_buffer(1024)
                    length = ctypes.c_uint32(1024)
                    if self.kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(length)):
                        exe = buf.value
            finally:
                self.kernel32.CloseHandle(handle)
        since = suspended.get(str(pid))
        is_suspended = since is not None and abs(int(since) - started_ms) <= START_SLACK_MS
        return Row(
            pid=pid,
            ppid=ppid,
            pgid=0,
            uid=0 if is_mine else 1,
            stat="T" if is_suspended else "S",
            started_ms=started_ms,
            cpu_pct=cpu_pct,
            mem_bytes=mem,
            exe=exe,
            args=args,
        )

    def ps(self) -> Dict[int, Row]:
        state = self._load()
        now_ms = self.now_ms()
        rows = {pid: self._row(pid, ppid, name, now_ms, state["suspended"]) for pid, ppid, name in self._toolhelp() if pid > 0}
        if not rows:
            raise RuntimeError("the process list was empty")
        # A launched server's group: every process below it, while it is the same process.
        launched = {int(pid): started for pid, started in state["launched"].items()}
        for pid in list(rows):
            cursor: Optional[Row] = rows[pid]
            for _ in range(64):
                if cursor is None:
                    break
                started = launched.get(cursor.pid)
                if started is not None and abs(cursor.started_ms - started) <= START_SLACK_MS:
                    rows[pid] = replace(rows[pid], pgid=cursor.pid)
                    break
                cursor = rows.get(cursor.ppid)
        return rows

    def listeners(self) -> List[Listener]:
        return parse_netstat_listeners(self.run(["netstat", "-ano", "-p", "TCP"]))

    def _cwd(self, pid: int) -> Optional[str]:
        """The working folder, read from the process's PEB (64-bit processes only)."""
        if ctypes.sizeof(ctypes.c_void_p) != 8:
            return None
        handle = self._open(pid, ACCESS_QUERY_LIMITED | ACCESS_QUERY | ACCESS_VM_READ)
        if handle is None:
            return None
        try:
            basic = (ctypes.c_uint64 * 6)()  # PROCESS_BASIC_INFORMATION: the PEB's address is its second field
            if self.ntdll.NtQueryInformationProcess(handle, 0, basic, ctypes.sizeof(basic), None) != 0 or not basic[1]:
                return None

            def read(address: int, size: int) -> Optional[bytes]:
                buf = ctypes.create_string_buffer(size)
                done = ctypes.c_size_t(0)
                if not self.kernel32.ReadProcessMemory(handle, address, buf, size, ctypes.byref(done)) or done.value != size:
                    return None
                return buf.raw

            pointer = read(basic[1] + 0x20, 8)  # PEB.ProcessParameters
            if pointer is None:
                return None
            current = read(int.from_bytes(pointer, "little") + 0x38, 16)  # RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath
            if current is None:
                return None
            length = int.from_bytes(current[0:2], "little")
            text = read(int.from_bytes(current[8:16], "little"), length) if 0 < length <= 2048 else None
            if text is None:
                return None
            path = text.decode("utf-16-le", "replace")
            return path.rstrip("\\") if len(path) > 3 else path
        except (OSError, ValueError, OverflowError):
            return None
        finally:
            self.kernel32.CloseHandle(handle)

    def cwds(self, pids: Iterable[int]) -> Dict[int, str]:
        result: Dict[int, str] = {}
        for pid in sorted(set(pids)):
            path = self._cwd(pid)
            if path:
                result[pid] = printable(path)
        return result

    # -- signals ------------------------------------------------------------ #

    def kill(self, pid: int, sig: int) -> None:
        name = next((key for key, value in SIGNALS.items() if value == sig), "TERM")
        handle = self._open(pid, ACCESS_SUSPEND_RESUME if name in ("STOP", "CONT") else ACCESS_TERMINATE)
        if handle is None:
            if ctypes.get_last_error() == ERROR_INVALID_PARAMETER:
                raise ProcessLookupError(pid)
            raise PermissionError(pid)
        try:
            if name == "STOP":
                self.ntdll.NtSuspendProcess(handle)
            elif name == "CONT":
                self.ntdll.NtResumeProcess(handle)
            else:
                self.kernel32.TerminateProcess(handle, 1)
        finally:
            self.kernel32.CloseHandle(handle)
        if name in ("STOP", "CONT"):
            state = self._load()
            if name == "STOP":
                row = self._row(pid, 0, "", self.now_ms(), {})
                state["suspended"][str(pid)] = row.started_ms
            else:
                state["suspended"].pop(str(pid), None)
            self._save(state)

    def killpg(self, pgid: int, sig: int) -> None:
        """Every process of a launched server's group, the newest first."""
        members = sorted((row for row in self.ps().values() if row.pgid == pgid), key=lambda row: -row.started_ms)
        if not members:
            raise ProcessLookupError(pgid)
        for row in members:
            try:
                self.kill(row.pid, sig)
            except ProcessLookupError:
                continue

    def spawn(self, argv: List[str], cwd: str, env: Dict[str, str], log_fd: int) -> int:
        # cmd.exe parses its own command line: `/s /c "command"`, not a re-quoted argument.
        line = f'{subprocess.list2cmdline(argv[:-1])} "{argv[-1]}"'
        flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            child = subprocess.Popen(line, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
        except OSError:  # the parent's job does not allow breaking away: stay in it
            child = subprocess.Popen(line, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, creationflags=flags, close_fds=True)
        state = self._load()
        row = self._row(child.pid, 0, "", self.now_ms(), {})
        state["launched"] = {pid: started for pid, started in state["launched"].items() if pid != str(child.pid)}
        state["launched"][str(child.pid)] = row.started_ms
        self._save(state)
        return child.pid


def snapshot(system: System, ctx: Context, dev_ports: Sequence[int], tails: Sequence[int], watch: Sequence[int], log_dir: str = LOG_DIR) -> Dict[str, object]:
    rows = system.ps()
    listeners = system.listeners()
    roots = session_roots(rows)
    dev_pids = [one.pid for one in listeners if one.port in set(dev_ports)]
    cwds = system.cwds([*roots, *dev_pids])
    logs = {port: read_tail(os.path.join(log_dir, f"{port}.log")) for port in tails}
    return build_snapshot(rows, listeners, cwds, dev_ports, ctx, system.now_ms(), logs, watch)


def send_signal(system: System, ctx: Context, sig_name: str, pid: int, expected_ms: int) -> Dict[str, object]:
    sig = SIGNALS.get(sig_name)
    if sig is None:
        return {"ok": False, "message": f"Unknown signal {sig_name}."}
    rows = system.ps()
    guarded = protected_pids(rows, ctx)
    why = refusal(rows, pid, ctx, guarded)
    row = rows.get(pid)
    if why is None and row is not None and abs(row.started_ms - expected_ms) > START_SLACK_MS:
        why = f"pid {pid} is a different process now (it started at another time)"
    name = (("Claude Code" if is_claude(row) else short_name(row.exe, row.args)) if row is not None else f"process {pid}")
    if why is not None:
        return {"ok": False, "pid": pid, "signal": sig_name, "message": f"Did not signal {name} ({pid}): {why}."}
    try:
        system.kill(pid, sig)
    except ProcessLookupError:
        return {"ok": False, "pid": pid, "signal": sig_name, "message": f"{name} ({pid}) had already exited."}
    except PermissionError:
        return {"ok": False, "pid": pid, "signal": sig_name, "message": f"Not allowed to signal {name} ({pid})."}
    verb = {"STOP": "Suspended", "CONT": "Resumed", "TERM": "Sent SIGTERM to", "KILL": "Force-killed"}[sig_name]
    return {"ok": True, "pid": pid, "signal": sig_name, "message": f"{verb} {name} ({pid})."}


# --------------------------------------------------------------------------- #
# Dev servers: launch and stop
# --------------------------------------------------------------------------- #


def launch_argv(command: str) -> List[str]:
    """A dev server's command line runs under /bin/sh (cmd.exe on Windows), so `a && b` works as typed."""
    if IS_WINDOWS:
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", command]
    return ["/bin/sh", "-c", command]


def launch_env(environ: Dict[str, str], home: str) -> Dict[str, str]:
    """The session's environment, with the usual tool folders on PATH (task, bun, uv)."""
    env = dict(environ)
    # Windows spells it Path, and a plain dict does not fold case.
    key = next((name for name in env if name.upper() == "PATH"), "PATH")
    parts = [part for part in env.get(key, "").split(os.pathsep) if part]
    extras = EXTRA_PATH_WINDOWS if IS_WINDOWS else EXTRA_PATH
    for extra in extras:
        folder = extra.replace("~", home, 1) if extra.startswith("~") else extra
        if folder not in parts:
            parts.append(folder)
    env[key] = os.pathsep.join(parts)
    return env


def rotate(path: str, limit: int = LOG_ROTATE_BYTES) -> None:
    try:
        if os.path.getsize(path) > limit:
            os.replace(path, f"{path}.1")
    except OSError:
        pass


def owner_text(rows: Dict[int, Row], listener: Listener) -> str:
    row = rows.get(listener.pid)
    name = short_name(row.exe, row.args) if row is not None else listener.command or "a process"
    return f"{name} (pid {listener.pid})"


def run_launch(system: System, port: int, cwd: str, command: str, log_dir: str = LOG_DIR, environ: Optional[Dict[str, str]] = None) -> Dict[str, object]:
    rows = system.ps()
    taken = [one for one in system.listeners() if one.port == port]
    if taken:
        return {"ok": False, "message": f":{port} is already in use by {owner_text(rows, taken[0])}."}
    if not os.path.isdir(cwd):
        return {"ok": False, "message": f"The folder {cwd} does not exist."}
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, f"{port}.log")
    rotate(path)
    env = launch_env(dict(os.environ) if environ is None else environ, os.path.expanduser("~"))
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(path, "ab") as log:
        log.write(f"\n=== {stamp} Session Monitor: starting `{redact(command)}` in {cwd} ===\n".encode("utf-8"))
        log.flush()
        try:
            pid = system.spawn(launch_argv(command), cwd, env, log.fileno())
        except OSError as error:
            return {"ok": False, "message": f"Could not start `{redact(command)}`: {error}."}
    return {"ok": True, "pid": pid, "pgid": pid, "log": path, "message": f"Started `{redact(command)}` (pid {pid}); its output goes to {path}."}


@dataclass
class StopPlan:
    groups: List[int]
    pids: List[int]
    names: List[str]
    refusal: Optional[str] = None


def plan_stop(rows: Dict[int, Row], listener_pids: Sequence[int], ctx: Context) -> StopPlan:
    """The whole process group of each listener when that is safe, else the
    listener and its descendants (never a Claude process, never this session)."""
    guarded = protected_pids(rows, ctx)
    plan = StopPlan(groups=[], pids=[], names=[])
    for pid in listener_pids:
        row = rows.get(pid)
        if row is None:
            continue
        why = refusal(rows, pid, ctx, guarded)
        if why is None and is_claude(row):
            why = "it is a Claude Code process"
        if why is not None:
            plan.refusal = f"Did not stop {short_name(row.exe, row.args)} ({pid}): {why}."
            return plan
        plan.names.append(short_name(row.exe, row.args))
        if group_is_safe(rows, row.pgid, ctx, guarded):
            if row.pgid not in plan.groups:
                plan.groups.append(row.pgid)
        else:
            for target in [pid, *descendants(rows, pid)]:
                target_row = rows.get(target)
                if target_row is None or target in guarded or target_row.uid != ctx.uid or is_claude(target_row):
                    continue
                if target not in plan.pids:
                    plan.pids.append(target)
    return plan


def remaining(rows: Dict[int, Row], plan: StopPlan, starts: Dict[int, int]) -> List[int]:
    """What of the plan still runs: any member of its groups, its own pids by identity."""
    alive = [row.pid for row in rows.values() if row.pgid in plan.groups and row.state != "zombie"]
    for pid, started in starts.items():
        row = rows.get(pid)
        if row is not None and row.state != "zombie" and abs(row.started_ms - started) <= START_SLACK_MS and pid not in alive:
            alive.append(pid)
    return sorted(alive)


def signal_plan(system: System, rows: Dict[int, Row], plan: StopPlan, sig: int, ctx: Context, starts: Dict[int, int]) -> List[str]:
    """Sends `sig` to the plan's groups (re-checked as safe) and pids (re-checked
    as the same processes); returns what it signalled."""
    guarded = protected_pids(rows, ctx)
    done: List[str] = []
    for pgid in plan.groups:
        if not group_is_safe(rows, pgid, ctx, guarded):
            continue
        try:
            system.killpg(pgid, sig)
            done.append(f"group {pgid}")
        except (ProcessLookupError, PermissionError):
            continue
    for pid in plan.pids:
        row = rows.get(pid)
        if pid in guarded or row is None or abs(row.started_ms - starts.get(pid, row.started_ms)) > START_SLACK_MS:
            continue
        try:
            system.kill(pid, sig)
            done.append(str(pid))
        except (ProcessLookupError, PermissionError):
            continue
    return done


def run_stop(system: System, port: int, timeout_s: float, ctx: Context) -> Dict[str, object]:
    rows = system.ps()
    on_port = [one for one in system.listeners() if one.port == port]
    if not on_port:
        return {"ok": True, "isFree": True, "message": f"Nothing was listening on :{port}."}
    plan = plan_stop(rows, [one.pid for one in on_port], ctx)
    if plan.refusal is not None:
        return {"ok": False, "isFree": False, "message": plan.refusal}
    starts = {pid: rows[pid].started_ms for pid in plan.pids if pid in rows}
    termed = signal_plan(system, rows, plan, SIGNALS["TERM"], ctx, starts)
    if not termed:
        return {"ok": False, "isFree": False, "message": f"Could not signal what listens on :{port}."}
    forced = False
    deadline = system.now_ms() + int(timeout_s * 1000)
    is_free = False
    while True:
        rows = system.ps()
        is_free = not any(one.port == port for one in system.listeners())
        alive = remaining(rows, plan, starts)
        if is_free and not alive:
            break
        if system.now_ms() >= deadline:
            if forced:
                break
            forced = True
            signal_plan(system, rows, plan, SIGNALS["KILL"], ctx, starts)
            deadline = system.now_ms() + 2_000
        system.sleep(0.25)
    name = plan.names[0] if plan.names else f"the server on :{port}"
    target = f"process group {', '.join(str(pgid) for pgid in plan.groups)}" if plan.groups else f"pids {', '.join(str(pid) for pid in plan.pids)}"
    how = f"SIGTERM, then SIGKILL after {timeout_s:g} s," if forced else "SIGTERM"
    if is_free:
        return {
            "ok": True,
            "isFree": True,
            "forced": forced,
            "groups": plan.groups,
            "pids": plan.pids,
            "message": f"Stopped {name} with {how} to {target}; :{port} is free.",
        }
    still = [one for one in system.listeners() if one.port == port]
    holder = owner_text(rows, still[0]) if still else "something"
    return {"ok": False, "isFree": False, "forced": forced, "groups": plan.groups, "pids": plan.pids, "message": f":{port} is still in use by {holder}."}


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #


def int_list(text: str) -> List[int]:
    return [int(part) for part in text.split(",") if part.strip().isdigit()]


def option(args: List[str], name: str) -> List[int]:
    if name in args:
        at = args.index(name)
        if at + 1 < len(args):
            return int_list(args[at + 1])
    return []


def main(argv: List[str], system: Optional[System] = None) -> Dict[str, object]:
    machine = system if system is not None else (WindowsSystem() if IS_WINDOWS else System())
    ctx = Context(me=os.getpid(), uid=0 if IS_WINDOWS else os.getuid())
    mode = argv[0] if argv else "snapshot"
    rest = argv[1:]
    if mode == "snapshot":
        return snapshot(machine, ctx, option(rest, "--dev"), option(rest, "--tail"), option(rest, "--watch"))
    if mode == "signal" and len(rest) == 3 and rest[1].isdigit() and rest[2].lstrip("-").isdigit():
        return send_signal(machine, ctx, rest[0].upper(), int(rest[1]), int(rest[2]))
    if mode == "launch" and len(rest) == 3 and rest[0].isdigit():
        return run_launch(machine, int(rest[0]), rest[1], rest[2])
    if mode == "stop" and rest and rest[0].isdigit():
        timeout = float(rest[1]) if len(rest) > 1 and rest[1].replace(".", "", 1).isdigit() else 5.0
        return run_stop(machine, int(rest[0]), min(timeout, 15.0), ctx)
    return {"ok": False, "message": f"Usage: procs.py snapshot|signal|launch|stop (got {' '.join(argv[:1])})."}


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception as error:  # noqa: BLE001 - one JSON answer whatever happens
        result = {"ok": False, "message": f"{type(error).__name__}: {error}"}
    print(json.dumps(result, separators=(",", ":")), flush=True)
