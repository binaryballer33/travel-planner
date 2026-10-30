"""Past sessions read back from Claude Code's own transcripts.

Claude Code writes every session to ``~/.claude/projects/<folder>/<id>.jsonl``:
each prompt, each tool call with its input, each result with its output, all
timestamped. The monitor's own records only begin with the version that kept
them; the transcripts go back as far as Claude Code kept them, so the pane can
show any earlier session of a project.

    transcripts.py list <project root>      the project's sessions, newest first
    transcripts.py read <project root> <id>  one session's prompts and calls
    transcripts.py agents <project root> <id> <agent id>...
                                             those agents' calls, from their own
                                             transcripts beside the session's
    transcripts.py cache <project root> <id>  the session's prompt cache: its
                                             requests' reads and writes, what
                                             its cached prefix holds, its agents'

A session belongs to a project when its working folder is the project's root
or a folder inside it (a worktree under ``.claude/worktrees`` included). The
summaries ``list`` makes are cached by file size and time, so only sessions
that changed are read again. Everything prints as one JSON value; texts are
cut so the whole stays well under 4 MiB.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from typing import Dict, Iterator, List, TypedDict, Union

MAX_PROMPTS = 300
MAX_CALLS = 400
# The calls an `agents` answer holds, all its agents' together: each agent's newest, an equal part each.
MAX_AGENT_CALLS = 1_000
AGENT_ID_CHARS = 80
# What a `cache` answer holds: the newest requests, the biggest items in the cached prefix, the agents most recently at work.
MAX_CACHE_REQUESTS = 100
# A request that wrote more than this, and half its prompt or more, wrote the cache again (as lib/cache.ts isRewrite).
REWRITE_TOKENS = 20_000
MAX_CACHE_ITEMS = 15
MAX_CACHE_AGENTS = 40
CACHE_TEXT_CHARS = 160
PROMPT_CHARS = 4_000
INPUT_CHARS = 1_000
OUTPUT_HEAD = 1_600
OUTPUT_TAIL = 400
TITLE_CHARS = 120
CACHE_VERSION = 3

JsonValue = Union[None, bool, int, float, str, List["JsonValue"], Dict[str, "JsonValue"]]
JsonObject = Dict[str, JsonValue]


class Summary(TypedDict):
    id: str
    path: str
    startedAt: int
    lastAt: int
    title: str
    prompts: int
    calls: int
    cwd: str
    branch: str


class Usage(TypedDict):
    """Tokens model requests reported, summed, and how many requests: one model's. Of the cache writes, those kept an hour."""

    model: str
    requests: int
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    cacheWrite1h: int


class Prompt(TypedDict, total=False):
    id: str
    text: str
    at: int
    usage: list[Usage]
    endedAt: int


class Call(TypedDict, total=False):
    id: str
    name: str
    input: JsonObject
    startedAt: int
    endedAt: int
    isError: bool
    output: str
    model: str
    promptId: str
    outputChars: int
    readBy: str


class AgentCalls(TypedDict):
    """One agent's calls, read from its own transcript, and the requests that read them, by message id."""

    id: str
    calls: list[Call]
    requests: dict[str, Usage]


class CacheRequest(TypedDict):
    """One model request's prompt as the prompt cache served it: read from it, written to it (by how long it is kept), and new."""

    id: str
    at: int
    model: str
    input: int
    output: int
    read: int
    write5m: int
    write1h: int


class CacheTotals(TypedDict):
    """One model's requests summed."""

    model: str
    requests: int
    input: int
    output: int
    read: int
    write5m: int
    write1h: int


class CacheItem(TypedDict, total=False):
    """Something in the cached prefix: a call's output or input, a prompt, a compaction's summary; its size in characters."""

    kind: str
    id: str
    name: str
    input: JsonObject
    text: str
    chars: int
    at: int


class CacheLoop(TypedDict):
    """
    A loop's prompt cache: its newest requests (oldest first), its requests
    summed by model, when it was compacted, and since the last compaction,
    when its prefix began, how big it was then, and what was added since:
    the biggest items and the characters of each kind.
    """

    requests: list[CacheRequest]
    totals: list[CacheTotals]
    rewrites: int
    resets: list[int]
    startedAt: int
    startTokens: int
    items: list[CacheItem]
    kinds: dict[str, int]


class CacheAgent(TypedDict):
    """An agent's own prompt cache, from its transcript: what it is, its last request, its requests summed by model."""

    id: str
    label: str
    type: str
    requests: int
    last: CacheRequest
    totals: list[CacheTotals]


class CacheAnswer(TypedDict):
    main: CacheLoop
    agents: list[CacheAgent]


class Session(TypedDict):
    id: str
    title: str
    cwd: str
    branch: str
    startedAt: int
    lastAt: int
    prompts: list[Prompt]
    calls: list[Call]
    requests: dict[str, Usage]


def claude_dir() -> str:
    """Where Claude Code keeps its files: ``$CLAUDE_CONFIG_DIR``, else ``~/.claude``."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def folder_name(path: str) -> str:
    """The projects folder Claude Code names after a working folder: every ``/`` and ``.`` a ``-``."""
    return "".join("-" if ch in "/." else ch for ch in path)


def candidate_dirs(projects: str, root: str) -> list[str]:
    """The project folders that may hold the root's sessions: its own, and those of folders inside it."""
    prefix = folder_name(root.rstrip("/"))
    try:
        names = os.listdir(projects)
    except OSError:
        return []
    return sorted(os.path.join(projects, name) for name in names if name == prefix or name.startswith(prefix + "-"))


def is_inside(cwd: str, root: str) -> bool:
    """Whether a working folder is the root or inside it."""
    root = root.rstrip("/")
    return cwd == root or cwd.startswith(root + "/")


def stamp(value: JsonValue) -> int:
    """An ISO timestamp as ms since the epoch; 0 when there is none."""
    if not isinstance(value, str) or value == "":
        return 0
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def records(path: str) -> Iterator[JsonObject]:
    """The transcript's records, in order; a line that is not JSON is skipped."""
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                yield value


def message_of(record: JsonObject) -> JsonObject:
    message = record.get("message")
    return message if isinstance(message, dict) else {}


def text_of(content: JsonValue) -> str:
    """A message's text: the string, or its text blocks joined."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [block.get("text") for block in content if isinstance(block, dict) and block.get("type") == "text"]
        return "\n".join(part for part in parts if isinstance(part, str))
    return ""


def is_prompt(record: JsonObject) -> bool:
    """
    A prompt the person sent: a user message of human origin, not the
    engine's (meta, caveats, commands, the summary a compaction writes, the
    note that a request was interrupted). Those carry the prompt's own id.
    """
    if record.get("type") != "user" or record.get("isMeta") is True or record.get("isSidechain") is True or record.get("isCompactSummary") is True:
        return False
    origin = record.get("origin")
    if isinstance(origin, dict) and origin.get("kind") != "human":
        return False
    content = message_of(record).get("content")
    if isinstance(content, list) and any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content):
        return False
    text = text_of(content).strip()
    return text != "" and not text.startswith("<local-command") and not text.startswith("<command-name>") and not text.startswith("[Request interrupted")


def queued_text(record: JsonObject) -> str:
    """The text of a prompt typed while Claude worked and delivered into the turn; '' for any other record."""
    if record.get("type") != "attachment":
        return ""
    attachment = record.get("attachment")
    if not isinstance(attachment, dict) or attachment.get("type") != "queued_command":
        return ""
    prompt = attachment.get("prompt")
    return text_of(prompt).strip() if isinstance(prompt, (str, list)) else ""


def clip(text: str, head: int, tail: int) -> str:
    """Long text cut to its head and tail, a note between them."""
    if len(text) <= head + tail:
        return text
    return f"{text[:head]}\n… {len(text) - head - tail:,} characters not kept …\n{text[-tail:]}" if tail > 0 else text[:head] + "…"


def short_input(value: JsonValue, depth: int = 0) -> JsonValue:
    """A tool's input with long texts cut (a Write's content, an Edit's strings), so the call's title still reads."""
    if isinstance(value, str):
        return clip(value, INPUT_CHARS, 0)
    if isinstance(value, list):
        return [short_input(item, depth + 1) for item in value[:20]] if depth < 4 else []
    if isinstance(value, dict):
        return {key: short_input(item, depth + 1) for key, item in list(value.items())[:30]} if depth < 4 else {}
    return value


def result_text(content: JsonValue) -> str:
    """A tool result's output as text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(text_of([block]) if isinstance(block, dict) else "" for block in content)
    return ""


def count(value: JsonValue) -> int:
    """A token count as the API reports it; 0 for anything else."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def usage_of(model: str, usage: JsonValue) -> Usage:
    """One request's tokens, as a message's ``usage`` reports them."""
    fields = usage if isinstance(usage, dict) else {}
    split = fields.get("cache_creation")
    return {
        "model": model,
        "requests": 1,
        "input": count(fields.get("input_tokens")),
        "output": count(fields.get("output_tokens")),
        "cacheRead": count(fields.get("cache_read_input_tokens")),
        "cacheWrite": count(fields.get("cache_creation_input_tokens")),
        "cacheWrite1h": count(split.get("ephemeral_1h_input_tokens")) if isinstance(split, dict) else 0,
    }


def add_usage(total: Usage, one: Usage) -> Usage:
    return {
        "model": total["model"],
        "requests": total["requests"] + one["requests"],
        "input": total["input"] + one["input"],
        "output": total["output"] + one["output"],
        "cacheRead": total["cacheRead"] + one["cacheRead"],
        "cacheWrite": total["cacheWrite"] + one["cacheWrite"],
        "cacheWrite1h": total["cacheWrite1h"] + one["cacheWrite1h"],
    }


class CallLog:
    """
    Tool calls and the model requests around them, fed one record at a time:
    each call with its outcome and the request that read its output, and each
    request once, by its message id (a response is written as a record for
    each of its blocks, each with the message's id and usage), with the owner
    it worked for. The first request after a call's result reads it.
    """

    def __init__(self) -> None:
        self.calls: dict[str, Call] = {}
        self.order: list[str] = []
        self.requests: dict[str, Usage] = {}
        self.owners: dict[str, str] = {}
        self.unread: list[str] = []

    def assistant(self, record: JsonObject, at: int, owner: str) -> None:
        """A response's record: its request, once, and the calls it asks for, filed under `owner` ('' for none)."""
        message = message_of(record)
        model = message.get("model")
        message_id = message.get("id")
        if isinstance(message_id, str) and message_id != "" and isinstance(model, str) and not model.startswith("<"):
            if message_id not in self.requests:
                self.owners[message_id] = owner
                for call_id in self.unread:
                    self.calls[call_id]["readBy"] = message_id
                self.unread = []
            self.requests[message_id] = usage_of(model, message.get("usage"))
        for block in message.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use" or not isinstance(block.get("id"), str):
                continue
            call_id = str(block.get("id"))
            tool_input = short_input(block.get("input"))
            call: Call = {
                "id": call_id,
                "name": str(block.get("name") or "tool"),
                "input": tool_input if isinstance(tool_input, dict) else {},
                "startedAt": at,
            }
            if isinstance(model, str):
                call["model"] = model
            if owner != "":
                call["promptId"] = owner
            if call_id not in self.calls:
                self.order.append(call_id)
            self.calls[call_id] = call

    def user(self, record: JsonObject, at: int) -> None:
        """A user record: the results it carries end their calls."""
        content = message_of(record).get("content")
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            found = self.calls.get(str(block.get("tool_use_id")))
            if found is None:
                continue
            output = result_text(block.get("content"))
            found["endedAt"] = at
            found["isError"] = block.get("is_error") is True
            found["output"] = clip(output, OUTPUT_HEAD, OUTPUT_TAIL)
            found["outputChars"] = len(output)
            self.unread.append(str(block.get("tool_use_id")))

    def newest(self, count: int) -> list[Call]:
        """The newest `count` calls, oldest first."""
        return [self.calls[call_id] for call_id in self.order[-count:]] if count > 0 else []

    def readers(self, kept: list[Call]) -> dict[str, Usage]:
        """The requests that read these calls' outputs, by message id."""
        read_by = {call.get("readBy") for call in kept}
        return {message_id: one for message_id, one in self.requests.items() if message_id in read_by}


def read_session(path: str) -> Session:
    """
    One transcript as the pane shows it: its prompts with the tokens their
    main loop's requests reported, and its main loop's calls with their
    outcomes and the request that read each one's output.

    A response is written as a record for each of its blocks, each with the
    message's id and its usage, so a request is counted once, by its id. The
    first request after a call's result reads it. Agents' requests are their
    own transcripts' and are not counted.
    """
    session_id = os.path.splitext(os.path.basename(path))[0]
    title = ""
    first_prompt = ""
    cwd = ""
    branch = ""
    started = 0
    last = 0
    prompts: list[Prompt] = []
    current = ""
    log = CallLog()
    ended: dict[str, int] = {}
    for record in records(path):
        at = stamp(record.get("timestamp"))
        if at > 0:
            started = at if started == 0 else min(started, at)
            last = max(last, at)
        kind = record.get("type")
        if kind == "custom-title" and isinstance(record.get("customTitle"), str):
            title = str(record.get("customTitle"))
            continue
        if cwd == "" and isinstance(record.get("cwd"), str):
            cwd = str(record.get("cwd"))
        if isinstance(record.get("gitBranch"), str) and record.get("gitBranch") != "":
            branch = str(record.get("gitBranch"))
        queued = queued_text(record)
        if is_prompt(record) or queued != "":
            text = queued or text_of(message_of(record).get("content")).strip()
            prompt_id = record.get("promptId") if isinstance(record.get("promptId"), str) else record.get("uuid")
            current = str(prompt_id or f"#{len(prompts)}")
            # Each prompt its own id, so none takes another's calls or requests.
            taken = {one["id"] for one in prompts}
            if current in taken:
                current = next(f"{current}~{n}" for n in range(2, len(prompts) + 3) if f"{current}~{n}" not in taken)
            prompts.append({"id": current, "text": text[:PROMPT_CHARS], "at": at})
            if first_prompt == "":
                first_prompt = text
            continue
        if record.get("isSidechain") is True:
            continue
        if current != "" and kind in ("assistant", "user") and at > 0:
            ended[current] = max(ended.get(current, 0), at)
        if kind == "assistant":
            log.assistant(record, at, current)
        elif kind == "user":
            log.user(record, at)
    kept = log.newest(MAX_CALLS)
    by_prompt: dict[str, dict[str, Usage]] = {}
    for message_id, one in log.requests.items():
        owner = log.owners.get(message_id, "")
        if owner == "":
            continue
        models = by_prompt.setdefault(owner, {})
        known = models.get(one["model"])
        models[one["model"]] = one if known is None else add_usage(known, one)
    for one in prompts:
        models = by_prompt.get(one["id"])
        if models:
            one["usage"] = sorted(models.values(), key=lambda usage: -usage["requests"])
        if one["id"] in ended:
            one["endedAt"] = ended[one["id"]]
    return {
        "id": session_id,
        "title": (title or first_prompt.strip().split("\n", 1)[0])[:TITLE_CHARS],
        "cwd": cwd,
        "branch": branch,
        "startedAt": started,
        "lastAt": last,
        "prompts": prompts[-MAX_PROMPTS:],
        "calls": kept,
        "requests": log.readers(kept),
    }


def is_agent_id(value: str) -> bool:
    """An agent id as Claude Code names its transcripts: letters, digits, `_` and `-`."""
    return 0 < len(value) <= AGENT_ID_CHARS and all(ch.isalnum() or ch in "-_" for ch in value)


def find_agent(session_path: str, agent_id: str) -> str | None:
    """
    An agent's own transcript, beside its session's: `<session>/subagents/
    agent-<id>.jsonl`, or a workflow agent's under `subagents/workflows/<run>/`.
    """
    if not is_agent_id(agent_id):
        return None
    folder = os.path.join(os.path.splitext(session_path)[0], "subagents")
    name = f"agent-{agent_id}.jsonl"
    direct = os.path.join(folder, name)
    if os.path.isfile(direct):
        return direct
    runs = os.path.join(folder, "workflows")
    for run in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
        path = os.path.join(runs, run, name)
        if os.path.isfile(path):
            return path
    return None


def read_agent(path: str, agent_id: str, limit: int) -> AgentCalls:
    """An agent's calls from its own transcript (every record its loop's), the newest `limit`, and the requests that read them."""
    log = CallLog()
    for record in records(path):
        kind = record.get("type")
        at = stamp(record.get("timestamp"))
        if kind == "assistant":
            log.assistant(record, at, "")
        elif kind == "user":
            log.user(record, at)
    kept = log.newest(limit)
    return {"id": agent_id, "calls": kept, "requests": log.readers(kept)}


def read_agents(session_path: str, agent_ids: list[str]) -> list[AgentCalls]:
    """These agents' calls, those whose transcripts are found, each its part of MAX_AGENT_CALLS."""
    found = [(agent_id, path) for agent_id in dict.fromkeys(agent_ids) for path in [find_agent(session_path, agent_id)] if path is not None]
    limit = MAX_AGENT_CALLS // max(1, len(found))
    return [read_agent(path, agent_id, limit) for agent_id, path in found]


def summarize(path: str) -> Summary:
    """What the picker lists of a session, read from its transcript."""
    session = read_session(path)
    return {
        "id": session["id"],
        "path": path,
        "startedAt": session["startedAt"],
        "lastAt": session["lastAt"],
        "title": session["title"],
        "prompts": len(session["prompts"]),
        "calls": len(session["calls"]),
        "cwd": session["cwd"],
        "branch": session["branch"],
    }


def summary_json(summary: Summary) -> JsonObject:
    """A summary as the cache file keeps it."""
    return {key: summary[key] for key in ("id", "path", "startedAt", "lastAt", "title", "prompts", "calls", "cwd", "branch")}


def summary_from(value: JsonValue) -> Summary | None:
    """A cached summary read back; None when it is not one."""
    if not isinstance(value, dict):
        return None
    texts = [value.get(key) for key in ("id", "path", "title", "cwd", "branch")]
    numbers = [value.get(key) for key in ("startedAt", "lastAt", "prompts", "calls")]
    if not all(isinstance(text, str) for text in texts) or not all(isinstance(number, int) for number in numbers):
        return None
    return {
        "id": str(value["id"]),
        "path": str(value["path"]),
        "startedAt": int(str(value["startedAt"])),
        "lastAt": int(str(value["lastAt"])),
        "title": str(value["title"]),
        "prompts": int(str(value["prompts"])),
        "calls": int(str(value["calls"])),
        "cwd": str(value["cwd"]),
        "branch": str(value["branch"]),
    }


def load_cache(path: str) -> dict[str, JsonValue]:
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("v") != CACHE_VERSION or not isinstance(value.get("files"), dict):
        return {}
    files = value.get("files")
    return files if isinstance(files, dict) else {}


def save_cache(path: str, files: dict[str, JsonValue]) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = f"{path}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"v": CACHE_VERSION, "files": files}, handle)
        os.replace(temporary, path)
    except OSError:
        pass


def list_sessions(root: str, projects: str, cache_path: str) -> list[Summary]:
    """The project's sessions, newest first: those with at least one prompt or call."""
    cache = load_cache(cache_path)
    fresh: dict[str, JsonValue] = {}
    found: list[Summary] = []
    for folder in candidate_dirs(projects, root):
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(folder, name)
            try:
                info = os.stat(path)
            except OSError:
                continue
            key = f"{info.st_size}:{int(info.st_mtime)}"
            cached = cache.get(path)
            summary = summary_from(cached.get("summary")) if isinstance(cached, dict) and cached.get("key") == key else None
            if summary is None:
                summary = summarize(path)
            fresh[path] = {"key": key, "summary": summary_json(summary)}
            if is_inside(summary["cwd"], root) and summary["prompts"] + summary["calls"] > 0:
                found.append(summary)
    save_cache(cache_path, fresh)
    return sorted(found, key=lambda one: one["lastAt"], reverse=True)


def find_session(root: str, projects: str, session_id: str) -> str | None:
    """The transcript of a session of the project, by its id."""
    for folder in candidate_dirs(projects, root):
        path = os.path.join(folder, f"{session_id}.jsonl")
        if os.path.isfile(path):
            return path
    return None


def cache_request(message_id: str, at: int, model: str, usage: JsonValue) -> CacheRequest:
    """A request's prompt by how the cache served it; a write without its split is counted as kept 5 minutes, the API's default."""
    fields = usage if isinstance(usage, dict) else {}
    split = fields.get("cache_creation")
    written = count(fields.get("cache_creation_input_tokens"))
    write1h = count(split.get("ephemeral_1h_input_tokens")) if isinstance(split, dict) else 0
    write5m = count(split.get("ephemeral_5m_input_tokens")) if isinstance(split, dict) else written
    return {
        "id": message_id,
        "at": at,
        "model": model,
        "input": count(fields.get("input_tokens")),
        "output": count(fields.get("output_tokens")),
        "read": count(fields.get("cache_read_input_tokens")),
        "write5m": write5m,
        "write1h": write1h,
    }


def is_rewrite(request: CacheRequest) -> bool:
    """A request that wrote most of its prompt again: the cache had expired or its prompt changed before it."""
    written = request["write5m"] + request["write1h"]
    return written > REWRITE_TOKENS and written >= 0.5 * (request["read"] + written)


def cache_totals(requests: list[CacheRequest]) -> list[CacheTotals]:
    """Requests summed by model, the most used first."""
    by_model: dict[str, CacheTotals] = {}
    for one in requests:
        known = by_model.get(one["model"])
        if known is None:
            by_model[one["model"]] = {"model": one["model"], "requests": 1, "input": one["input"], "output": one["output"], "read": one["read"], "write5m": one["write5m"], "write1h": one["write1h"]}
        else:
            for field in ("input", "output", "read", "write5m", "write1h"):
                known[field] += one[field]
            known["requests"] += 1
    return sorted(by_model.values(), key=lambda totals: -totals["requests"])


class CacheLog:
    """
    A loop's requests and what its prompt holds, fed record by record: each
    request once, by its message id (its last record's usage), the
    compactions, and since the last one the items its prompt took in.
    """

    def __init__(self) -> None:
        self.requests: dict[str, CacheRequest] = {}
        self.resets: list[int] = []
        self.started_at = 0
        self.start_tokens = -1
        self.items: list[CacheItem] = []
        self.kinds: dict[str, int] = {"results": 0, "inputs": 0, "prompts": 0, "replies": 0, "summaries": 0}
        self.uses: dict[str, tuple[str, JsonObject]] = {}

    def reset(self, at: int) -> None:
        """A compaction: the prompt starts over from its summary."""
        self.resets.append(at)
        self.started_at = at
        self.start_tokens = -1
        self.items = []
        self.kinds = {kind: 0 for kind in self.kinds}

    def add(self, item: CacheItem, kind: str) -> None:
        self.kinds[kind] = self.kinds.get(kind, 0) + item.get("chars", 0)
        self.items.append(item)

    def assistant(self, record: JsonObject, at: int) -> None:
        message = message_of(record)
        model = message.get("model")
        message_id = message.get("id")
        if isinstance(message_id, str) and message_id != "" and isinstance(model, str) and not model.startswith("<"):
            request = cache_request(message_id, at, model, message.get("usage"))
            if message_id not in self.requests:
                if self.started_at == 0:
                    self.started_at = at
                if self.start_tokens < 0:
                    self.start_tokens = request["read"] + request["write5m"] + request["write1h"] + request["input"]
            self.requests[message_id] = request
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                self.kinds["replies"] += len(str(block.get("text")))
            elif block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                raw = block.get("input")
                tool_input = short_input(raw)
                name = str(block.get("name") or "tool")
                chars = len(json.dumps(raw))
                self.uses[str(block.get("id"))] = (name, tool_input if isinstance(tool_input, dict) else {})
                self.add({"kind": "input", "id": str(block.get("id")), "name": name, "input": tool_input if isinstance(tool_input, dict) else {}, "chars": chars, "at": at}, "inputs")

    def user(self, record: JsonObject, at: int) -> None:
        content = message_of(record).get("content")
        if record.get("isCompactSummary") is True:
            text = text_of(content)
            self.add({"kind": "summary", "text": text[:CACHE_TEXT_CHARS], "chars": len(text), "at": at}, "summaries")
            return
        if is_prompt(record):
            text = text_of(content).strip()
            self.add({"kind": "prompt", "text": text[:CACHE_TEXT_CHARS], "chars": len(text), "at": at}, "prompts")
            return
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            call_id = str(block.get("tool_use_id"))
            name, tool_input = self.uses.get(call_id, ("tool", {}))
            self.add({"kind": "result", "id": call_id, "name": name, "input": tool_input, "chars": len(result_text(block.get("content"))), "at": at}, "results")

    def loop(self) -> CacheLoop:
        ordered = sorted(self.requests.values(), key=lambda request: request["at"])
        return {
            "requests": ordered[-MAX_CACHE_REQUESTS:],
            "totals": cache_totals(ordered),
            "rewrites": sum(1 for request in ordered if is_rewrite(request)),
            "resets": self.resets,
            "startedAt": self.started_at,
            "startTokens": max(0, self.start_tokens),
            "items": sorted(self.items, key=lambda item: -item.get("chars", 0))[:MAX_CACHE_ITEMS],
            "kinds": self.kinds,
        }


def read_cache_loop(path: str, is_agent: bool) -> CacheLoop:
    """A loop's prompt cache from its transcript: the session's main loop (its sidechain records left out), or an agent's own."""
    log = CacheLog()
    for record in records(path):
        if record.get("isSidechain") is True and not is_agent:
            continue
        kind = record.get("type")
        at = stamp(record.get("timestamp"))
        if kind == "system" and record.get("subtype") == "compact_boundary":
            log.reset(at)
        elif kind == "assistant":
            log.assistant(record, at)
        elif kind == "user":
            log.user(record, at)
    return log.loop()


def agent_files(session_path: str) -> list[str]:
    """The session's agents' own transcripts, the most recently written first."""
    folder = os.path.join(os.path.splitext(session_path)[0], "subagents")
    found: list[str] = []
    for base, _, names in os.walk(folder) if os.path.isdir(folder) else []:
        found.extend(os.path.join(base, name) for name in names if name.startswith("agent-") and name.endswith(".jsonl"))
    return sorted(found, key=lambda path: -os.path.getmtime(path))


def agent_meta(path: str) -> JsonObject:
    """An agent's meta file beside its transcript (its type and description); empty when there is none."""
    meta = path[: -len(".jsonl")] + ".meta.json"
    try:
        with open(meta, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def read_cache(session_path: str) -> CacheAnswer:
    """The session's prompt cache: its main loop's, and its agents' (the MAX_CACHE_AGENTS most recently at work) that made a request."""
    agents: list[CacheAgent] = []
    for path in agent_files(session_path)[:MAX_CACHE_AGENTS]:
        loop = read_cache_loop(path, True)
        if not loop["requests"]:
            continue
        meta = agent_meta(path)
        agent_id = os.path.basename(path)[len("agent-") : -len(".jsonl")]
        agents.append(
            {
                "id": agent_id,
                "label": str(meta.get("description") or "")[:CACHE_TEXT_CHARS],
                "type": str(meta.get("agentType") or "")[:60],
                "requests": sum(totals["requests"] for totals in loop["totals"]),
                "last": loop["requests"][-1],
                "totals": loop["totals"],
            }
        )
    return {"main": read_cache_loop(session_path, False), "agents": agents}


def main(argv: list[str]) -> int:
    projects = os.path.join(claude_dir(), "projects")
    cache_path = os.path.join(claude_dir(), "session-monitor", "transcripts-cache.json")
    if len(argv) >= 2 and argv[0] == "list":
        print(json.dumps(list_sessions(argv[1], projects, cache_path)))
        return 0
    if len(argv) >= 3 and argv[0] == "read":
        if not all(ch.isalnum() or ch == "-" for ch in argv[2]):
            print(json.dumps({"error": "not a session id"}))
            return 1
        path = find_session(argv[1], projects, argv[2])
        if path is None:
            print(json.dumps({"error": "no transcript for that session"}))
            return 1
        print(json.dumps(read_session(path)))
        return 0
    if len(argv) >= 4 and argv[0] == "agents":
        if not all(ch.isalnum() or ch == "-" for ch in argv[2]) or not all(is_agent_id(one) for one in argv[3:]):
            print(json.dumps({"error": "not a session or agent id"}))
            return 1
        path = find_session(argv[1], projects, argv[2])
        if path is None:
            print(json.dumps({"error": "no transcript for that session"}))
            return 1
        print(json.dumps({"agents": read_agents(path, argv[3:])}))
        return 0
    if len(argv) >= 3 and argv[0] == "cache":
        if not all(ch.isalnum() or ch == "-" for ch in argv[2]):
            print(json.dumps({"error": "not a session id"}))
            return 1
        path = find_session(argv[1], projects, argv[2])
        if path is None:
            print(json.dumps({"error": "no transcript for that session"}))
            return 1
        print(json.dumps(read_cache(path)))
        return 0
    print(json.dumps({"error": "usage: transcripts.py list <root> | read <root> <id> | agents <root> <id> <agent id>... | cache <root> <id>"}))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
