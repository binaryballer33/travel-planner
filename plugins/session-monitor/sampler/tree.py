#!/usr/bin/env python3
"""Session Monitor folder lister.

Lists one folder for the Files tab's folder tree and prints one JSON object:

    {"path": ..., "entries": [{"name", "kind", "size", "isPartial", "mode",
     "mtimeMs", "isHidden", "linkTarget"?, "error"?}, ...],
     "total": ..., "hiddenTotal": ..., "truncated": ..., "error"?: ...}

`kind` is dir, file, link or other, read without following a symbolic link.
Folders come first, then everything else, each alphabetical ignoring case. A
folder's size is the total of the files it holds, walked with os.scandir
without following symbolic links, under one time budget for the whole listing,
shared fairly between its folders: a size still being added up when its share
runs out is marked partial. Visible and hidden entries are each capped.

A path outside `--root` (after resolving links and `..`) is refused, and every
error becomes a field of the answer (the listing's, or one entry's), never a
crash. Standard library only (Python 3.9+), run as
`python3 -I tree.py <folder> --root <working folder>`.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple, Union

DEFAULT_BUDGET_MS = 1500
DEFAULT_MAX_ENTRIES = 400
#: How many entries a size walk reads between looks at the clock.
CLOCK_EVERY = 256

Clock = Callable[[], float]
JsonScalar = Union[str, int, bool]
JsonEntry = Dict[str, JsonScalar]
JsonListing = Dict[str, Union[str, int, bool, List[JsonEntry]]]


@dataclass
class Entry:
    """One entry of the listed folder, as the pane draws it."""

    name: str
    kind: str
    size: int
    is_partial: bool
    mode: str
    mtime_ms: int
    is_hidden: bool
    link_target: Optional[str] = None
    error: Optional[str] = None

    def as_json(self) -> JsonEntry:
        out: JsonEntry = {
            "name": self.name,
            "kind": self.kind,
            "size": self.size,
            "isPartial": self.is_partial,
            "mode": self.mode,
            "mtimeMs": self.mtime_ms,
            "isHidden": self.is_hidden,
        }
        if self.link_target is not None:
            out["linkTarget"] = self.link_target
        if self.error is not None:
            out["error"] = self.error
        return out


@dataclass
class Listing:
    """One folder's listing: its kept entries and what was left out."""

    path: str
    entries: List[Entry] = field(default_factory=list)
    total: int = 0
    hidden_total: int = 0
    truncated: bool = False
    error: Optional[str] = None

    def as_json(self) -> JsonListing:
        out: JsonListing = {
            "path": self.path,
            "entries": [entry.as_json() for entry in self.entries],
            "total": self.total,
            "hiddenTotal": self.hidden_total,
            "truncated": self.truncated,
        }
        if self.error is not None:
            out["error"] = self.error
        return out


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #


def is_hidden(name: str) -> bool:
    return name.startswith(".")


def kind_of(mode: int) -> str:
    """dir, file, link or other, of the entry itself (an lstat mode)."""
    if stat.S_ISLNK(mode):
        return "link"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISREG(mode):
        return "file"
    return "other"


def sort_key(name: str, is_dir: bool) -> Tuple[int, str, str]:
    """Folders first, then the rest, each alphabetical ignoring case."""
    return (0 if is_dir else 1, name.casefold(), name)


def error_text(error: OSError) -> str:
    return error.strerror or type(error).__name__


def is_inside(path: str, root: str) -> bool:
    """True when `path` is `root` or below it, both already resolved."""
    if path == root:
        return True
    prefix = root if root.endswith(os.sep) else root + os.sep
    return path.startswith(prefix)


# --------------------------------------------------------------------------- #
# The file system
# --------------------------------------------------------------------------- #


def tree_size(path: str, deadline: float, now: Clock) -> Tuple[int, bool]:
    """The bytes of every file under `path`, links not followed, and whether
    the total is partial (the deadline came first, or a folder could not be
    read). Raises OSError only when `path` itself cannot be read."""
    total = 0
    is_partial = False
    seen = 0
    stack: List[str] = []
    first = True
    while first or stack:
        current = path if first else stack.pop()
        if now() >= deadline:
            return total, True
        try:
            with os.scandir(current) as children:
                for child in children:
                    seen += 1
                    if seen % CLOCK_EVERY == 0 and now() >= deadline:
                        return total, True
                    try:
                        if child.is_dir(follow_symlinks=False):
                            stack.append(child.path)
                        else:
                            total += child.stat(follow_symlinks=False).st_size
                    except OSError:
                        is_partial = True
        except OSError:
            if first:
                raise
            is_partial = True
        first = False
    return total, is_partial


def read_entry(folder: str, name: str) -> Entry:
    """An entry with its own size, mode and time; a folder's size comes later."""
    full = os.path.join(folder, name)
    try:
        info = os.lstat(full)
    except OSError as error:
        return Entry(name, "other", 0, False, "?---------", 0, is_hidden(name), error=error_text(error))
    kind = kind_of(info.st_mode)
    entry = Entry(
        name=name,
        kind=kind,
        size=info.st_size if kind != "dir" else 0,
        is_partial=False,
        mode=stat.filemode(info.st_mode),
        mtime_ms=int(info.st_mtime * 1000),
        is_hidden=is_hidden(name),
    )
    if kind == "link":
        try:
            entry.link_target = os.readlink(full)
        except OSError as error:
            entry.error = error_text(error)
    return entry


def list_folder(
    path: str,
    root: Optional[str] = None,
    budget_ms: int = DEFAULT_BUDGET_MS,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    now: Clock = time.monotonic,
) -> Listing:
    """Lists `path`: entries sorted and capped, folder sizes within the budget."""
    deadline = now() + max(0, budget_ms) / 1000.0
    listing = Listing(path=path)
    if root is not None:
        real = os.path.realpath(path)
        if not is_inside(real, os.path.realpath(root)):
            listing.error = "outside the working folder"
            return listing
    try:
        with os.scandir(path) as children:
            found = [(child.name, child.is_dir(follow_symlinks=False)) for child in children]
    except OSError as error:
        listing.error = error_text(error)
        return listing
    except ValueError as error:
        listing.error = str(error)
        return listing
    found.sort(key=lambda item: sort_key(item[0], item[1]))
    visible = [name for name, _ in found if not is_hidden(name)]
    hidden = [name for name, _ in found if is_hidden(name)]
    cap = max(0, max_entries)
    listing.total = len(found)
    listing.hidden_total = len(hidden)
    listing.truncated = len(visible) > cap or len(hidden) > cap
    listing.entries = [read_entry(path, name) for name in visible[:cap] + hidden[:cap]]
    folders = [entry for entry in listing.entries if entry.kind == "dir" and entry.error is None]
    # Visible folders are sized first; time one leaves over goes to the next.
    for index, entry in enumerate(folders):
        share = max(0.0, deadline - now()) / (len(folders) - index)
        try:
            entry.size, entry.is_partial = tree_size(os.path.join(path, entry.name), now() + share, now)
        except OSError as error:
            entry.is_partial = True
            entry.error = error_text(error)
    return listing


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="List one folder as JSON for the Session Monitor pane.")
    parser.add_argument("path")
    parser.add_argument("--root", default=None)
    parser.add_argument("--budget-ms", type=int, default=DEFAULT_BUDGET_MS)
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    args = parser.parse_args(argv)
    path: str = args.path
    root: Optional[str] = args.root
    budget_ms: int = args.budget_ms
    max_entries: int = args.max_entries
    try:
        listing = list_folder(path, root, budget_ms, max_entries)
    except Exception as error:  # noqa: BLE001 - the pane gets the error as data
        listing = Listing(path=path, error=f"{type(error).__name__}: {error}")
    sys.stdout.write(json.dumps(listing.as_json(), ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
