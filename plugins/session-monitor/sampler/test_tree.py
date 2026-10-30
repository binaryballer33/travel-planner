"""Unit tests for the folder lister: run with
/usr/bin/python3 -m unittest discover -s sampler -v   (from the mod folder)
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from typing import Dict, List

from tree import Entry, is_inside, kind_of, list_folder, main, sort_key, tree_size


IS_WINDOWS = sys.platform == "win32"
MISSING = "The system cannot find the path specified" if IS_WINDOWS else "No such file or directory"
POSIX_ONLY = unittest.skipIf(IS_WINDOWS, "POSIX modes, links and permissions")


def write(path: str, size: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"x" * size)


def by_name(entries: List[Entry]) -> Dict[str, Entry]:
    return {entry.name: entry for entry in entries}


class FolderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.temp.name)

    def tearDown(self) -> None:
        for folder, dirs, _ in os.walk(self.root):
            for name in dirs:
                with contextlib.suppress(OSError):
                    os.chmod(os.path.join(folder, name), 0o755)
        self.temp.cleanup()

    def path(self, *parts: str) -> str:
        return os.path.join(self.root, *parts)


class SizesTest(FolderTest):
    def test_folder_size_is_the_total_of_its_files(self) -> None:
        write(self.path("src", "a.py"), 10)
        write(self.path("src", "deep", "b.py"), 20)
        write(self.path("README.md"), 7)
        listing = list_folder(self.root, self.root)
        entries = by_name(listing.entries)
        self.assertEqual(entries["src"].kind, "dir")
        self.assertEqual(entries["src"].size, 30)
        self.assertFalse(entries["src"].is_partial)
        self.assertEqual(entries["README.md"].size, 7)
        self.assertEqual(entries["README.md"].kind, "file")
        self.assertIsNone(listing.error)

    def test_an_empty_folder_is_zero_and_complete(self) -> None:
        os.makedirs(self.path("empty"))
        entry = by_name(list_folder(self.root).entries)["empty"]
        self.assertEqual((entry.size, entry.is_partial), (0, False))

    def test_a_tiny_budget_marks_folder_sizes_partial(self) -> None:
        write(self.path("big", "a.bin"), 100)
        entry = by_name(list_folder(self.root, budget_ms=0).entries)["big"]
        self.assertTrue(entry.is_partial)
        self.assertLessEqual(entry.size, 100)

    def test_a_walk_stops_at_its_deadline(self) -> None:
        for index in range(600):
            write(self.path("many", f"f{index}"), 1)
        ticks = iter(range(1_000_000))

        def clock() -> float:
            return float(next(ticks))

        # Each look at the clock moves it one second: the walk gets one look in.
        size, is_partial = tree_size(self.path("many"), 1.5, clock)
        self.assertTrue(is_partial)
        self.assertLess(size, 600)

    def test_time_one_folder_leaves_over_goes_to_the_next(self) -> None:
        write(self.path("a", "x"), 5)
        write(self.path("b", "y"), 6)
        entries = by_name(list_folder(self.root, budget_ms=5_000).entries)
        self.assertEqual((entries["a"].size, entries["a"].is_partial), (5, False))
        self.assertEqual((entries["b"].size, entries["b"].is_partial), (6, False))


class EntriesTest(FolderTest):
    def test_hidden_entries_are_flagged(self) -> None:
        write(self.path(".env"), 3)
        write(self.path(".git", "HEAD"), 4)
        write(self.path("app.py"), 1)
        entries = by_name(list_folder(self.root).entries)
        self.assertTrue(entries[".env"].is_hidden)
        self.assertTrue(entries[".git"].is_hidden)
        self.assertEqual(entries[".git"].size, 4)
        self.assertFalse(entries["app.py"].is_hidden)
        self.assertEqual(list_folder(self.root).hidden_total, 2)

    @POSIX_ONLY
    def test_modes_read_as_ls_prints_them(self) -> None:
        write(self.path("secret.txt"), 1)
        os.chmod(self.path("secret.txt"), 0o640)
        write(self.path("run.sh"), 1)
        os.chmod(self.path("run.sh"), 0o755)
        os.makedirs(self.path("dir"))
        os.chmod(self.path("dir"), 0o750)
        entries = by_name(list_folder(self.root).entries)
        self.assertEqual(entries["secret.txt"].mode, "-rw-r-----")
        self.assertEqual(entries["run.sh"].mode, "-rwxr-xr-x")
        self.assertEqual(entries["dir"].mode, "drwxr-x---")
        self.assertGreater(entries["run.sh"].mtime_ms, 1_000_000_000_000)

    def test_folders_first_then_files_ignoring_case(self) -> None:
        os.makedirs(self.path("B"))
        os.makedirs(self.path("a"))
        write(self.path("D.txt"), 1)
        write(self.path("c.txt"), 1)
        names = [entry.name for entry in list_folder(self.root).entries]
        self.assertEqual(names, ["a", "B", "c.txt", "D.txt"])
        self.assertLess(sort_key("Z", True), sort_key("a", False))

    @POSIX_ONLY
    def test_symlinks_are_not_followed(self) -> None:
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        write(os.path.join(outside.name, "huge.bin"), 5_000)
        write(self.path("pkg", "mod.py"), 10)
        os.symlink(os.path.join(outside.name, "huge.bin"), self.path("pkg", "link.bin"))
        os.symlink(self.root, self.path("pkg", "loop"))
        os.symlink(outside.name, self.path("elsewhere"))
        entries = by_name(list_folder(self.root, self.root).entries)
        pkg = entries["pkg"]
        # The folder counts its links' own few bytes, never what they lead to.
        self.assertFalse(pkg.is_partial)
        self.assertLess(pkg.size, 1_000)
        self.assertGreaterEqual(pkg.size, 10)
        link = entries["elsewhere"]
        self.assertEqual(link.kind, "link")
        self.assertEqual(link.link_target, outside.name)
        self.assertTrue(link.mode.startswith("l"))
        # Listing through the link would leave the root: refused.
        self.assertEqual(list_folder(self.path("elsewhere"), self.root).error, "outside the working folder")

    def test_each_group_is_capped_and_the_listing_says_so(self) -> None:
        for index in range(10):
            write(self.path(f"f{index:02}"), 1)
        write(self.path(".hidden"), 1)
        listing = list_folder(self.root, max_entries=3)
        self.assertEqual([entry.name for entry in listing.entries], ["f00", "f01", "f02", ".hidden"])
        self.assertTrue(listing.truncated)
        self.assertEqual((listing.total, listing.hidden_total), (11, 1))
        self.assertFalse(list_folder(self.root).truncated)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads everything")
    @POSIX_ONLY
    def test_an_unreadable_folder_is_an_entry_error_not_a_crash(self) -> None:
        write(self.path("locked", "a"), 1)
        write(self.path("open", "inner", "b"), 2)
        os.chmod(self.path("locked"), 0o000)
        os.chmod(self.path("open", "inner"), 0o000)
        entries = by_name(list_folder(self.root).entries)
        self.assertEqual(entries["locked"].error, "Permission denied")
        self.assertTrue(entries["locked"].is_partial)
        self.assertEqual(entries["locked"].mode, "d---------")
        # A folder deeper down that cannot be read makes the total partial.
        self.assertTrue(entries["open"].is_partial)
        self.assertIsNone(entries["open"].error)
        listing = list_folder(self.path("locked"))
        self.assertEqual((listing.error, listing.entries), ("Permission denied", []))


class GuardsTest(FolderTest):
    def test_paths_outside_the_root_are_refused(self) -> None:
        os.makedirs(self.path("inner"))
        self.assertIsNone(list_folder(self.path("inner"), self.root).error)
        self.assertEqual(list_folder(self.path("inner", "..", ".."), self.root).error, "outside the working folder")
        sep = os.sep
        self.assertTrue(is_inside(f"{sep}a{sep}b", f"{sep}a"))
        self.assertTrue(is_inside(f"{sep}a", f"{sep}a"))
        self.assertFalse(is_inside(f"{sep}ab", f"{sep}a"))
        self.assertTrue(is_inside(f"{sep}x", sep))
        if IS_WINDOWS:
            self.assertTrue(is_inside("C:\\Users\\Me\\proj", "c:\\users\\me"))

    def test_a_missing_folder_is_an_error_field(self) -> None:
        listing = list_folder(self.path("gone"))
        self.assertEqual(listing.error, MISSING)
        self.assertEqual(kind_of(0o100644), "file")

    def test_the_command_prints_one_json_object(self) -> None:
        write(self.path(".env"), 2)
        write(self.path("docs", "a.md"), 3)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main([self.root, "--root", self.root, "--budget-ms", "500", "--max-entries", "50"])
        self.assertEqual(code, 0)
        answer = json.loads(out.getvalue())
        self.assertEqual(answer["path"], self.root)
        self.assertEqual(answer["truncated"], False)
        self.assertEqual(answer["hiddenTotal"], 1)
        docs = answer["entries"][0]
        self.assertEqual(
            {key: docs[key] for key in ("name", "kind", "size", "isPartial", "isHidden")},
            {"name": "docs", "kind": "dir", "size": 3, "isPartial": False, "isHidden": False},
        )
        self.assertNotIn("linkTarget", docs)
        self.assertNotIn("error", answer)

    def test_the_command_answers_an_error_as_data(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main([self.path("gone"), "--root", self.root])
        answer = json.loads(out.getvalue())
        self.assertEqual((answer["entries"], answer["error"]), ([], MISSING))


if __name__ == "__main__":
    unittest.main()
