"""Tests for reading past sessions back from Claude Code's transcripts."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest

import transcripts

ROOT = "/Users/me/repo"


def line(record: transcripts.JsonObject) -> str:
    return json.dumps(record) + "\n"


def prompt(text: str, at: str, prompt_id: str, cwd: str = ROOT) -> transcripts.JsonObject:
    return {
        "type": "user",
        "origin": {"kind": "human"},
        "promptId": prompt_id,
        "uuid": f"u-{prompt_id}",
        "timestamp": at,
        "cwd": cwd,
        "gitBranch": "main",
        "message": {"role": "user", "content": text},
    }


def tool_use(call_id: str, name: str, tool_input: transcripts.JsonObject, at: str) -> transcripts.JsonObject:
    return {
        "type": "assistant",
        "timestamp": at,
        "message": {"model": "claude-opus-5-5", "content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]},
    }


def tool_result(call_id: str, output: str, at: str, is_error: bool = False) -> transcripts.JsonObject:
    block: transcripts.JsonObject = {"type": "tool_result", "tool_use_id": call_id, "content": output}
    if is_error:
        block["is_error"] = True
    return {"type": "user", "timestamp": at, "message": {"role": "user", "content": [block]}}


def response(message_id: str, blocks: list[transcripts.JsonObject], at: str, model: str = "claude-opus-5-5", tokens: tuple[int, int, int, int] = (2, 300, 40_000, 1_000)) -> list[transcripts.JsonObject]:
    """A response as Claude Code writes it: a record for each block, each with the message's id and usage."""
    usage: transcripts.JsonObject = {"input_tokens": tokens[0], "output_tokens": tokens[1], "cache_read_input_tokens": tokens[2], "cache_creation_input_tokens": tokens[3], "service_tier": "standard"}
    return [{"type": "assistant", "timestamp": at, "message": {"id": message_id, "model": model, "content": [block], "usage": usage}} for block in blocks]


def use_block(call_id: str, name: str, tool_input: transcripts.JsonObject) -> transcripts.JsonObject:
    return {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}


class TranscriptsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.projects = os.path.join(self.dir.name, "projects")
        self.cache = os.path.join(self.dir.name, "cache.json")
        os.makedirs(self.projects)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def write(self, folder: str, session_id: str, rows: list[transcripts.JsonObject]) -> str:
        path = os.path.join(self.projects, folder, f"{session_id}.jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.writelines(line(row) for row in rows)
            handle.write("not json\n")
        return path

    def test_reads_prompts_calls_and_outcomes(self) -> None:
        path = self.write(
            transcripts.folder_name(ROOT),
            "s1",
            [
                {"type": "custom-title", "customTitle": "Fix the tests"},
                prompt("run the tests\nplease", "2026-10-14T10:00:00Z", "p1"),
                tool_use("toolu_a", "Bash", {"command": "npm test", "description": "Run the tests"}, "2026-10-14T10:00:05Z"),
                tool_result("toolu_a", "2 failed", "2026-10-14T10:00:09Z", is_error=True),
                {"type": "user", "isMeta": True, "message": {"content": "<local-command-caveat>x</local-command-caveat>"}},
                {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": "a task finished"}},
                {"type": "attachment", "timestamp": "2026-10-14T10:00:20Z", "attachment": {"type": "queued_command", "prompt": "also fix lint"}},
                tool_use("toolu_b", "Write", {"file_path": "/repo/a.py", "content": "x" * 5_000}, "2026-10-14T10:00:30Z"),
                tool_result("toolu_b", "written", "2026-10-14T10:00:31Z"),
                {"type": "assistant", "isSidechain": True, "timestamp": "2026-10-14T10:00:40Z", "message": {"content": [{"type": "tool_use", "id": "toolu_side", "name": "Read", "input": {}}]}},
            ],
        )
        session = transcripts.read_session(path)
        self.assertEqual(session["title"], "Fix the tests")
        self.assertEqual([one["text"] for one in session["prompts"]], ["run the tests\nplease", "also fix lint"])
        self.assertEqual([one["id"] for one in session["calls"]], ["toolu_a", "toolu_b"])
        first, second = session["calls"]
        self.assertEqual(first.get("promptId"), "p1")
        self.assertTrue(first.get("isError"))
        self.assertEqual(first.get("output"), "2 failed")
        self.assertEqual(first.get("endedAt", 0) - first.get("startedAt", 0), 4_000)
        self.assertEqual(first.get("model"), "claude-opus-5-5")
        # A long input is cut, so a Write's content does not ride along whole.
        content = second.get("input", {}).get("content")
        self.assertIsInstance(content, str)
        self.assertLess(len(str(content)), 1_100)
        # The delivered prompt files the calls after it.
        self.assertNotEqual(second.get("promptId"), "p1")
        self.assertEqual(session["branch"], "main")

    def test_counts_each_request_once_for_its_prompt_and_names_the_one_that_read_each_output(self) -> None:
        path = self.write(
            transcripts.folder_name(ROOT),
            "s2",
            [
                prompt("read the code", "2026-10-14T10:00:00Z", "p1"),
                *response("msg_1", [{"type": "thinking", "thinking": ""}, use_block("toolu_a", "Read", {"file_path": "/repo/a.py"}), use_block("toolu_b", "Grep", {"pattern": "x"})], "2026-10-14T10:00:02Z", tokens=(3, 200, 0, 20_000)),
                tool_result("toolu_a", "a" * 3_000, "2026-10-14T10:00:03Z"),
                tool_result("toolu_b", "b" * 10, "2026-10-14T10:00:03Z"),
                # A sub-agent's request, and the engine's own made-up message: neither is the prompt's.
                {"type": "assistant", "isSidechain": True, "timestamp": "2026-10-14T10:00:04Z", "message": {"id": "msg_side", "model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 9, "output_tokens": 9}}},
                {"type": "assistant", "timestamp": "2026-10-14T10:00:04Z", "message": {"id": "msg_fake", "model": "<synthetic>", "content": [{"type": "text", "text": "No response"}], "usage": {"input_tokens": 0, "output_tokens": 0}}},
                *response("msg_2", [{"type": "text", "text": "done"}], "2026-10-14T10:00:06Z", tokens=(5, 400, 20_000, 3_500)),
                prompt("and the tests", "2026-10-14T10:01:00Z", "p2"),
                *response("msg_3", [use_block("toolu_c", "Bash", {"command": "pytest"})], "2026-10-14T10:01:02Z", model="claude-sonnet-5-5", tokens=(1, 50, 23_000, 100)),
                tool_result("toolu_c", "ok", "2026-10-14T10:01:09Z"),
            ],
        )
        session = transcripts.read_session(path)
        first, second = session["prompts"]
        # msg_1 and msg_2 once each, though msg_1 came as three records.
        self.assertEqual(first.get("usage"), [{"model": "claude-opus-5-5", "requests": 2, "input": 8, "output": 600, "cacheRead": 20_000, "cacheWrite": 23_500, "cacheWrite1h": 0}])
        self.assertEqual(first.get("endedAt"), transcripts.stamp("2026-10-14T10:00:06Z"))
        self.assertEqual(second.get("usage"), [{"model": "claude-sonnet-5-5", "requests": 1, "input": 1, "output": 50, "cacheRead": 23_000, "cacheWrite": 100, "cacheWrite1h": 0}])
        self.assertEqual(second.get("endedAt"), transcripts.stamp("2026-10-14T10:01:09Z"))
        calls = {call["id"]: call for call in session["calls"]}
        # The request after the results read both; the last result, nothing yet.
        self.assertEqual([calls[one].get("readBy") for one in ("toolu_a", "toolu_b", "toolu_c")], ["msg_2", "msg_2", None])
        self.assertEqual(calls["toolu_a"].get("outputChars"), 3_000)
        self.assertLess(len(calls["toolu_a"].get("output", "")), 3_000)
        # The table names only the requests that read a call.
        self.assertEqual(list(session["requests"]), ["msg_2"])
        self.assertEqual(session["requests"]["msg_2"], {"model": "claude-opus-5-5", "requests": 1, "input": 5, "output": 400, "cacheRead": 20_000, "cacheWrite": 3_500, "cacheWrite1h": 0})
        # A write's split, where the transcript has it: those kept an hour.
        split = transcripts.usage_of("m", {"cache_creation_input_tokens": 900, "cache_creation": {"ephemeral_1h_input_tokens": 600, "ephemeral_5m_input_tokens": 300}})
        self.assertEqual((split["cacheWrite"], split["cacheWrite1h"]), (900, 600))
        self.assertEqual(transcripts.add_usage(split, split)["cacheWrite1h"], 1_200)

    def test_a_compaction_summary_and_an_interruption_are_not_prompts_and_no_two_prompts_share_an_id(self) -> None:
        summary = prompt("This session is being continued from a previous conversation", "2026-10-14T10:00:10Z", "p1")
        summary["isCompactSummary"] = True
        summary.pop("origin")
        interrupted = prompt("[Request interrupted by user]", "2026-10-14T10:00:20Z", "p1")
        interrupted.pop("origin")
        path = self.write(
            transcripts.folder_name(ROOT),
            "s4",
            [
                prompt("first", "2026-10-14T10:00:00Z", "p1"),
                summary,
                interrupted,
                *response("msg_1", [use_block("toolu_a", "Read", {"file_path": "/a"})], "2026-10-14T10:00:30Z"),
                prompt("second, under the same id", "2026-10-14T10:01:00Z", "p1"),
                *response("msg_2", [use_block("toolu_b", "Read", {"file_path": "/b"})], "2026-10-14T10:01:30Z"),
            ],
        )
        session = transcripts.read_session(path)
        self.assertEqual([one["text"] for one in session["prompts"]], ["first", "second, under the same id"])
        self.assertEqual([one["id"] for one in session["prompts"]], ["p1", "p1~2"])
        self.assertEqual([call.get("promptId") for call in session["calls"]], ["p1", "p1~2"])
        self.assertEqual([[usage["requests"] for usage in one.get("usage", [])] for one in session["prompts"]], [[1], [1]])

    def test_a_prompt_with_no_request_has_no_usage(self) -> None:
        path = self.write(transcripts.folder_name(ROOT), "s3", [prompt("hi", "2026-10-14T10:00:00Z", "p1"), {"type": "assistant", "timestamp": "2026-10-14T10:00:01Z", "message": {"model": "claude-opus-5-5", "content": [], "usage": "nope"}}])
        session = transcripts.read_session(path)
        self.assertNotIn("usage", session["prompts"][0])
        self.assertEqual(session["requests"], {})
        self.assertEqual(transcripts.usage_of("m", {"input_tokens": True, "output_tokens": -3, "cache_read_input_tokens": "9"})["input"], 0)

    def write_agent(self, session_path: str, agent_id: str, rows: list[transcripts.JsonObject], run: str = "") -> str:
        """An agent's own transcript beside its session's, a workflow agent's under its run."""
        folder = os.path.join(os.path.splitext(session_path)[0], "subagents", *(["workflows", run] if run else []))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"agent-{agent_id}.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            # Every record of an agent's loop is marked a sidechain.
            handle.writelines(line({**row, "isSidechain": True, "agentId": agent_id}) for row in rows)
        return path

    def test_reads_an_agents_calls_from_its_own_transcript_and_a_workflow_agents_from_its_run(self) -> None:
        session = self.write(transcripts.folder_name(ROOT), "s5", [prompt("look around", "2026-10-14T10:00:00Z", "p1")])
        self.write_agent(
            session,
            "a1b2c3",
            [
                {"type": "user", "timestamp": "2026-10-14T10:00:01Z", "message": {"role": "user", "content": "Find the config"}},
                *response("msg_a1", [use_block("toolu_x1", "Grep", {"pattern": "config"})], "2026-10-14T10:00:02Z", model="claude-sonnet-5-5"),
                tool_result("toolu_x1", "c" * 2_500, "2026-10-14T10:00:03Z"),
                *response("msg_a2", [use_block("toolu_x2", "Read", {"file_path": "/repo/config.py"})], "2026-10-14T10:00:04Z", model="claude-sonnet-5-5"),
                tool_result("toolu_x2", "x = 1", "2026-10-14T10:00:05Z", is_error=True),
            ],
        )
        self.write_agent(session, "wfagent9", [*response("msg_w1", [use_block("toolu_w1", "Bash", {"command": "ls"})], "2026-10-14T10:01:00Z"), tool_result("toolu_w1", "a.py", "2026-10-14T10:01:01Z")], run="wf_abc-123")
        found = transcripts.read_agents(session, ["a1b2c3", "wfagent9", "missing", "a1b2c3"])
        self.assertEqual([one["id"] for one in found], ["a1b2c3", "wfagent9"])
        first, second = found
        self.assertEqual([call["id"] for call in first["calls"]], ["toolu_x1", "toolu_x2"])
        self.assertEqual([call.get("readBy") for call in first["calls"]], ["msg_a2", None])
        self.assertEqual(first["calls"][0].get("outputChars"), 2_500)
        self.assertTrue(first["calls"][1].get("isError"))
        self.assertEqual(first["calls"][0].get("model"), "claude-sonnet-5-5")
        # An agent's calls belong to no prompt of the session's.
        self.assertNotIn("promptId", first["calls"][0])
        self.assertEqual(list(first["requests"]), ["msg_a2"])
        self.assertEqual([call["name"] for call in second["calls"]], ["Bash"])

    def test_an_agents_answer_holds_each_agent_its_part_of_the_newest_calls(self) -> None:
        session = self.write(transcripts.folder_name(ROOT), "s6", [prompt("go", "2026-10-14T10:00:00Z", "p1")])
        for agent_id in ("agent1", "agent2"):
            rows = [row for n in range(transcripts.MAX_AGENT_CALLS) for row in (*response(f"msg_{agent_id}_{n}", [use_block(f"toolu_{agent_id}_{n}", "Read", {"file_path": f"/f{n}"})], "2026-10-14T10:00:01Z"), tool_result(f"toolu_{agent_id}_{n}", "ok", "2026-10-14T10:00:02Z"))]
            self.write_agent(session, agent_id, rows)
        found = transcripts.read_agents(session, ["agent1", "agent2"])
        half = transcripts.MAX_AGENT_CALLS // 2
        self.assertEqual([len(one["calls"]) for one in found], [half, half])
        self.assertEqual(found[0]["calls"][-1]["id"], f"toolu_agent1_{transcripts.MAX_AGENT_CALLS - 1}")

    def test_agents_refuses_odd_ids_and_says_when_the_session_is_not_found(self) -> None:
        self.assertIsNone(transcripts.find_agent(os.path.join(self.projects, "x.jsonl"), "../../etc/passwd"))
        self.assertFalse(transcripts.is_agent_id("a/b"))
        self.assertFalse(transcripts.is_agent_id(""))
        self.assertTrue(transcripts.is_agent_id("a1cf03bcdd4ebfc97"))
        for argv, wanted in ((["agents", ROOT, "s1", "../x"], "not a session or agent id"), (["agents", ROOT, "nope", "a1"], "no transcript for that session")):
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                self.assertEqual(transcripts.main(argv), 1)
            self.assertIn(wanted, printed.getvalue())

    def test_the_prompt_cache_of_the_main_loop_its_requests_split_by_how_long_writes_are_kept_and_what_it_holds_since_its_compaction(self) -> None:
        def cached(message_id: str, blocks: list[transcripts.JsonObject], at: str, read: int, write1h: int, write5m: int = 0, model: str = "claude-opus-5-5") -> list[transcripts.JsonObject]:
            rows = response(message_id, blocks, at, model=model, tokens=(2, 50, read, write1h + write5m))
            for row in rows:
                usage = transcripts.message_of(row).get("usage")
                if isinstance(usage, dict):
                    usage["cache_creation"] = {"ephemeral_1h_input_tokens": write1h, "ephemeral_5m_input_tokens": write5m}
            return rows

        summary = prompt("This session is being continued from a previous conversation", "2026-10-14T11:00:00Z", "p1")
        summary["isCompactSummary"] = True
        summary.pop("origin")
        path = self.write(
            transcripts.folder_name(ROOT),
            "s7",
            [
                prompt("first", "2026-10-14T10:00:00Z", "p1"),
                *cached("msg_1", [use_block("toolu_old", "Read", {"file_path": "/a"})], "2026-10-14T10:00:01Z", 0, 20_000),
                tool_result("toolu_old", "old " * 500, "2026-10-14T10:00:02Z"),
                {"type": "system", "subtype": "compact_boundary", "timestamp": "2026-10-14T11:00:00Z"},
                summary,
                *cached("msg_2", [{"type": "text", "text": "Picking up."}, use_block("toolu_new", "Bash", {"command": "cat big.log"})], "2026-10-14T11:00:05Z", 0, 30_000),
                tool_result("toolu_new", "x" * 9_000, "2026-10-14T11:00:06Z"),
                prompt("and now?", "2026-10-14T11:01:00Z", "p2"),
                *cached("msg_3", [{"type": "text", "text": "Done."}], "2026-10-14T11:01:05Z", 30_000, 2_500),
                # A sub-agent's request in the session's file is the agent's, not the main loop's.
                {"type": "assistant", "isSidechain": True, "timestamp": "2026-10-14T11:01:06Z", "message": {"id": "msg_side", "model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 9}}},
            ],
        )
        main = transcripts.read_cache(path)["main"]
        self.assertEqual([one["id"] for one in main["requests"]], ["msg_1", "msg_2", "msg_3"])
        self.assertEqual({key: main["requests"][-1][key] for key in ("read", "write1h", "write5m", "input", "output")}, {"read": 30_000, "write1h": 2_500, "write5m": 0, "input": 2, "output": 50})
        self.assertEqual(main["totals"], [{"model": "claude-opus-5-5", "requests": 3, "input": 6, "output": 150, "read": 30_000, "write5m": 0, "write1h": 52_500}])
        self.assertEqual(main["resets"], [transcripts.stamp("2026-10-14T11:00:00Z")])
        # The first after the compaction wrote its 30k prompt whole; the first of all its 20k (not more than 20k).
        self.assertEqual(main["rewrites"], 1)
        # Since the compaction: its prompt began at 30k (the summary and what came with it), then took in the rest.
        self.assertEqual((main["startedAt"], main["startTokens"]), (transcripts.stamp("2026-10-14T11:00:00Z"), 30_002))
        self.assertEqual([(item["kind"], item.get("name", ""), item["chars"]) for item in main["items"][:2]], [("result", "Bash", 9_000), ("summary", "", len("This session is being continued from a previous conversation"))])
        self.assertNotIn("toolu_old", [item.get("id") for item in main["items"]])
        self.assertEqual(main["kinds"]["replies"], len("Picking up.") + len("Done."))
        self.assertEqual(main["kinds"]["prompts"], len("and now?"))
        self.assertEqual(main["kinds"]["results"], 9_000)

    def test_the_prompt_cache_of_each_agent_from_its_own_transcript_the_most_recently_at_work_first(self) -> None:
        session = self.write(transcripts.folder_name(ROOT), "s8", [prompt("go", "2026-10-14T10:00:00Z", "p1")])
        older = self.write_agent(session, "agentold", [*response("msg_o", [{"type": "text", "text": "hi"}], "2026-10-14T10:00:01Z", model="claude-sonnet-5-5", tokens=(1, 10, 0, 4_000))])
        newer = self.write_agent(session, "agentnew", [*response("msg_n1", [{"type": "text", "text": "a"}], "2026-10-14T10:00:02Z"), *response("msg_n2", [{"type": "text", "text": "b"}], "2026-10-14T10:00:03Z")], run="wf_run-1")
        self.write_agent(session, "agentidle", [{"type": "user", "timestamp": "2026-10-14T10:00:04Z", "message": {"role": "user", "content": "nothing asked yet"}}])
        with open(newer[: -len(".jsonl")] + ".meta.json", "w", encoding="utf-8") as handle:
            json.dump({"agentType": "workflow-subagent", "description": "Judge it"}, handle)
        os.utime(older, (1, 1))
        agents = transcripts.read_cache(session)["agents"]
        # The idle agent made no request: it has no cache.
        self.assertEqual([one["id"] for one in agents], ["agentnew", "agentold"])
        first = agents[0]
        self.assertEqual((first["label"], first["type"], first["requests"], first["last"]["id"]), ("Judge it", "workflow-subagent", 2, "msg_n2"))
        # A write without its split is one kept 5 minutes.
        self.assertEqual((agents[1]["last"]["write5m"], agents[1]["last"]["write1h"]), (4_000, 0))

    def test_cache_refuses_odd_ids(self) -> None:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertEqual(transcripts.main(["cache", ROOT, "../x"]), 1)
        self.assertIn("not a session id", printed.getvalue())

    def test_long_output_keeps_head_and_tail(self) -> None:
        text = "a" * 5_000 + "END"
        clipped = transcripts.clip(text, 100, 10)
        self.assertTrue(clipped.startswith("a" * 100))
        self.assertTrue(clipped.endswith("aaaaaaaEND"))
        self.assertIn("characters not kept", clipped)

    def test_lists_the_projects_sessions_newest_first_from_its_worktrees_too(self) -> None:
        self.write(transcripts.folder_name(ROOT), "old", [prompt("first", "2026-10-01T10:00:00Z", "p")])
        worktree = f"{ROOT}/.claude/worktrees/feature-x"
        self.write(transcripts.folder_name(worktree), "new", [prompt("second", "2026-10-10T10:00:00Z", "p", cwd=worktree)])
        # Another project whose folder name shares the prefix, and a session with nothing in it.
        self.write(transcripts.folder_name(ROOT + "-other"), "elsewhere", [prompt("x", "2026-10-12T10:00:00Z", "p", cwd=ROOT + "-other")])
        self.write(transcripts.folder_name(ROOT), "empty", [{"type": "custom-title", "customTitle": "nothing"}])
        found = transcripts.list_sessions(ROOT, self.projects, self.cache)
        self.assertEqual([one["id"] for one in found], ["new", "old"])
        self.assertEqual(found[0]["title"], "second")
        # The second listing comes from the cache, with the same answer.
        self.assertTrue(os.path.isfile(self.cache))
        self.assertEqual(transcripts.list_sessions(ROOT, self.projects, self.cache), found)

    def test_a_cached_summary_is_validated(self) -> None:
        self.assertIsNone(transcripts.summary_from({"id": 3}))
        self.assertIsNone(transcripts.summary_from("x"))

    def test_finds_a_session_by_id_and_refuses_odd_ids(self) -> None:
        path = self.write(transcripts.folder_name(ROOT), "abc-123", [prompt("x", "2026-10-01T10:00:00Z", "p")])
        self.assertEqual(transcripts.find_session(ROOT, self.projects, "abc-123"), path)
        self.assertIsNone(transcripts.find_session(ROOT, self.projects, "missing"))
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertEqual(transcripts.main(["read", ROOT, "../etc/passwd"]), 1)
        self.assertIn("not a session id", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
