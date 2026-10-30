# Session Monitor

A Claude Code mod that shows, live and color coded, what a session costs your machine, how
long it spent on the network and on commands, which websites it used, and what it changed.

## Turning it on and off

Install it with `/plugin marketplace add binaryballer33/shaqs-claude-plugins` then
`/plugin install session-monitor@shaqs-claude-plugins`. Once installed it runs in every session.

| To | Do |
| --- | --- |
| Pause it in this session only (no sampling, no polling, pane closed) | `/session-monitor off` |
| Resume it in this session | `/session-monitor on` |
| Open the pane, or jump to a tab | `/session-monitor`, `/session-monitor commands`, `/session-monitor sources`, … |
| Hide or show the quick-stats strip above the prompt | `/session-monitor bar off`, `/session-monitor bar on` |
| Stop or resume asking a small model to title your prompts | `/session-monitor summaries off`, `/session-monitor summaries on` |
| Turn it off everywhere | `claude plugin disable session-monitor@shaqs-claude-plugins`, then `/reload-plugins` in open sessions |
| Turn it back on everywhere | `claude plugin enable session-monitor@shaqs-claude-plugins`, then `/reload-plugins` |
| Remove it | `claude plugin uninstall session-monitor@shaqs-claude-plugins` |
| Restart it in a session (after an update, or if it misbehaves) | `/reload-plugins` |

Commands and file activity are still recorded while paused, so the history is complete when
you resume.

## Quick stats under the prompt

The status line under the prompt shows the whole Mac and nothing else:
`CPU 23% · Mem 61% · ↓ 1.20 MB/s ↑ 40.0 kB/s · ping 38 ms`. That is the CPU in use across
every core, the memory in use as a share of the RAM (Activity Monitor's Memory Used: app,
wired and compressed), the download and upload speed over Wi-Fi, Ethernet and cellular, and
how long a connection to the Claude API takes. The latency shows once a probe has answered
and drops out while it fails. A figure not measured yet, or while the sampler is stopped, is
a dash.

The status line is plain text, so it can't be clicked. A one-row **quick-stats strip** just
above the prompt has buttons that open the pane on a tab, in the tab bar's order: Overview,
`3 prompts` (Prompts), `2 agents · 1 live` (Agents), `142 cmds` (Commands), `1 commit`
(Commits, counting this session's), `±9 files (+120 −45)` (Files), Explorer and `18 sources` (Sources). The strip gives
way to Claude's own surveys, hides while the monitor is paused, and `/session-monitor bar off` hides
it for good (`/session-monitor bar on` brings it back).

## Tabs

The tabs, in the bar's order, with their hotkeys: Overview (**o**), Prompts (**p**), Agents
(**a**), Commands (**c**), Commits (**g**), Files (**f**), Explorer (**e**), Sources (**s**),
Resources (**r**), Compute (**m**), Ports (**t**) and Cache (**h**). A letter opens its tab while the pane has the
focus: in the terminal once the pane holds the keyboard (ctrl+x tab, or a click), and in the
desktop app, which draws no hotkeys of its own, once a click has given the focus to the tab bar
or a row (the pane's regions hear the letters themselves). With ctrl or ⌘ held, a letter is the
app's, not the pane's.

Every tab's header shows the total internet data the session has used, with counts on the
Commands, Files and Sources tabs. Overview, Compute and Resources also show live rates, and
the session's memory with its share of the Mac's RAM (`Mem 1.21 GB (7.0%)`). Token
counts read as k and M (590k, 1M). Section titles (Session, Time spent, CPU, Power & energy,
…) are headings, drawn larger than the text under them in the desktop app (and the VS Code
extension). The terminal can't draw larger text, so there they stay bold, in the accent
color.

**Cards:** every tab draws its sections as cards: a rounded box, softly filled in the desktop
app, with room inside and between them, its key numbers as figures (the name above the
value). An opened row's detail is a card under it. Memory reads with its share of the Mac's
RAM wherever it shows (`439 MB (2.6%)`; a sliver of it `<0.1%`, never `0.0%`).

**Past sessions:** each session of a project is saved as it goes (at every turn's end, on
changes at most every 45 seconds, and when it ends), trimmed to fit: prompts, calls (no
output), agents, files, commits, artifacts and usage. The Prompts, Agents, Files, Commits
and Commands tabs, and Overview's Session and Artifacts cards, have a session picker: choose
an earlier session to see its record, read-only, under a "Viewing a past session" banner
with a way back. The newest 10 sessions per project are kept. A past session's files open
as they are today; its commits open while they still exist in the repository.

Claude Code's own transcripts (`~/.claude/projects/`) fill in the rest. The picker also lists
the project's sessions the monitor never recorded (those from before it was installed, and
those in its worktrees), up to 40 in all; one of them shows its prompts and calls, each
prompt with the tokens and cost its main loop's requests reported (a sub-agent's requests are in
the agent's own transcript and are not counted) and each call with its share of the request
that read its output, split as the live session splits it; it has no machine figures. Reading
a transcript, a compaction's summary and an interruption's note are not taken for prompts,
though Claude Code writes them under the prompt's own id. Every past session's opened call shows its output as the
transcript kept it (a long one keeps its start and end) instead of only its first line. When
the app is closed and reopened, the session's earlier prompts, calls, agents, files and
artifacts come back into its tabs from its record and its transcript, with their outputs;
a call that was running when the app closed shows as stopped (⊘).

**Opening a row:** click its line (commands, commits, a commit's files, the Files tab); click
it again to close it. There is no arrow: a row lights up while the pointer is over it (a soft
gray background in the desktop app, the title inverted in the terminal), and an open row has
a bar (▍) at its left edge and a bold title, and in the desktop app it stays lit. In the
terminal and the desktop app a row's line is one clickable region; in the VS Code extension,
which can't draw those regions, the row's title is a button. When a command's or an agent's
row is too narrow for all its figures (when it started, how long it took, energy, network,
memory, model and effort), they move onto a line of their own under the title, wrapping onto
more lines as they must, so none is cut off; the title keeps its line. On that line the figures
sit close (half the usual gap, no fixed column widths), so they usually fit on one.

**File icons:** every file row (the Files tab, its folder tree, a commit's files) starts
with an icon for the file's type, as an editor's tree does: a badge in the language's colour
(`TS`, `py`, `{}` for JSON, `$` for a shell script, `M↓` for Markdown) or an emoji where one
reads at a glance (🐳 for a Dockerfile, 🔒 for a lock file, 🔑 for an `.env`); 📄 for the rest.
The table is `hooks/lib/icons.ts`.

**Opening it:** `/session-monitor` (or `/monitor`, kept as an alias) opens the pane; the quick-stats
strip above the chat has an Overview button beside the tab counts. At the session's start the
pane opens once a surface that draws is attached.

**The tab bar in the desktop app** is drawn by a small module of its own (`hooks/view/tab-bar.tsx`,
a `Client` region). A plain button of the pane is pressed by the handle the engine gave it in the
drawing the app shows, and every redraw (each second on a live tab) hands out new handles, so a
click that landed between a redraw and the app drawing it did nothing. A press inside the region
is addressed by the region's key, which stays from one redraw to the next, so a tab click always
lands. A click that only moves the focus ring onto a tab switches it too. In the terminal the
tabs stay plain buttons with their hotkeys. Should a region of the mod's fail on a surface (its
module throws, never answers, or the desktop app tears it down for sending too much), that
module is left out on that surface for 30 seconds and its plain version takes its place: plain
tab buttons, a title button, a button per effort level, a plain list row. Then it is tried
again; each failure after that doubles the wait, up to 16 minutes. The desktop app reports
every region of a frame it tears down at once, and those reports count as one failure.

**How big a drawing may be.** The desktop app's renderer draws a pane only while its drawing
has fewer than 2,000 nodes (every element and every piece of text counts), is less than 32 deep,
and holds fewer than 262,144 characters (labels, text, code, an SVG's whole source, a region's
data). Past any of them it keeps showing the drawing before, and that drawing's buttons no
longer press: the engine has already let go of them. That is what wedged the pane: a long
session's Prompts tab came to 4,005 elements. The engine itself draws no more than 100,000
characters of text in a drawing and leaves the rest blank. So every long list (Commands,
Agents, Prompts, Files and its folder tree, a commit's files, Sources' searches and websites)
stops at 1,000 nodes and 85,000 characters (`LIST_BUDGET` in `hooks/lib/fit.ts`), and a code
view at 120,000 characters of SVG. Sources' By task view holds its tasks to it, an open task's
searches and websites to 70% of it (`PANEL_SHARE` in `hooks/view/sources-tasks.tsx`) and the
other tasks to the rest. A list's rows are weighed as the engine sends them (a link it sends as
plain text is a node more). A note says what was left out and, for most lists, how to reach it; a
commit's files (`… 312 more files`), the older searches and the last URLs of a website cut
short (`… 17 older searches not drawn`, `… 2 more`) are only counted, and a folder of more
entries than fit points to **Open in Finder**. The tests hold every tab of a long session to
these bounds, counted as the desktop app counts them (`tests/heavy.ts`). Under all of that is
a net for the whole pane, which nothing the tests know of reaches any more: on every surface but the terminal (which draws a tree of any size),
a tab whose drawing comes to 1,990 nodes, 31 deep or 255,000 characters (`PANE_SAFE` in
`hooks/view/pane.tsx`) is not drawn. It is weighed as the engine sends it: its text held to the
engine's 100,000 characters, and a link the engine will not send (an `http:` site, an `@` in the
URL) as the plain text it sends instead, a node more. Nodes and depth are counted as the app counts
them, so the net sits just under the app's own bounds and turns away little the app would draw. The
header stays, and in the tab's place a notice, **This view is too big for the app to draw**, says
which bound it reached, with the pane's and the app's. Its **Close what is open** button closes
every open command and its full output, the open prompt card, the open commit, the open agent, an
open task's sources and the diff; or pick another tab.

**Model & effort controls:** Overview opens with a card to change them. Picking a model or
moving the slider changes nothing until you press **Apply** at the card's top right, which runs
`/model <name>` and then `/effort <level>`. The model is the
`/config` Model row's list (Default, Sonnet, Opus, Haiku, Fable, the 1M-context ones, Opus plan
mode), set as the menu would set it; one your organization locks is shown, not offered. Effort is
a slider from Faster to Smarter with a stop per level (Low, Medium, High, Extra, Max): press or
drag along it. It runs `/effort <level>`, which waits for the session to be idle, so the card
says the level is set and applies from the next request until a request uses it. Where the
surface draws no slider (VS Code, the mobile app) each level is a button.

**The pane's width:** every open asks for 57 columns, about 400 px of the desktop app's text.
Only the terminal's fullscreen dock honours that, and there the engine keeps a width you drag
it to. The desktop app sizes its side panel itself: from your last drag of a plugin pane, kept
as that pane's share of the window (in its local storage, `lastPaneFlexByKind.plugin`, and per
session). No plugin can set it, so drag the panel to the width you want once and the app keeps
it. Earlier versions kept the width the pane was drawn at and asked for it again, which only
shrank the request to what the desktop app had given; that stored width is dropped.

**Agents on Overview** are cards too, edged amber while they work, red when they failed, grey when
stopped and the faint blue when done.

**Each call is a card:** in Commands, an agent's calls and Overview's Most recent commands,
every call sits in a card of its own, with room inside and between them. Its edge says how it
went: the title blue (faint) when it finished, red when it failed, amber while it runs, grey
when it was stopped; in the desktop app its card is a shade lighter than the section around it.
An opened call's details sit inside its card.

**A command's outline:** a shell call's second line (in Commands, an agent's calls and
Overview's Most recent commands) outlines its command rather than printing it whole: the
programs it runs, the variables it sets and the loops it makes, in order (`cd · python3
fetch_gsa_rates.py · W= · for loop · grep · tail`). Quotes are honoured and a heredoc's body
is skipped. Each part has a colour of its own: a program bold in its colour, the same in every
row (`cd` blue, `git` green, `tail` purple, `wc` orange; any other picked by its name), a
variable gold and a loop pink, with dim dots between. Open the call to see the whole command,
highlighted.

**Network on every call and prompt:** every call's row shows its network (`⇅ 12.4 MB`),
and an opened call shows it down and up. Only shell commands are measured on their own; a
call that runs inside Claude Code (Read, Edit, the web tools) shows `⇅ —`. Overview's Most recent commands show each call's network and model and effort too. An
agent's row (Agents tab and Overview) shows its shell calls' network added up (a background
shell, its command's) and its model and effort. Every prompt
shows its calls' network added up: on its group's header in Commands, as "Network of its
calls" on its card in Prompts, and on its line in Overview. The card's "Network, whole
session" is everything the session moved while the prompt ran, Claude's own requests included.

**Alerts:** a toast when a shell call moves 50 MB, runs past two minutes, or fails. Energy
raises none: it shows on the call's row.

**Nothing is cut off:** no card shortens text with an ellipsis. A title, label, caption or
query too long for its room wraps onto more lines, and the figures beside it stay in view.
Free text in a row of fixed columns starts at a readable width and never shrinks below it: where the row is too narrow, the row wraps and the text moves under the columns rather than being squeezed a letter per line.
The pane can't scroll sideways: the engine's boxes only show or hide what overflows, and
the pane scrolls up and down alone, so wrapping is how a card shows all of a row. (In the
VS Code extension a row's title is a button, whose label is still cut to fit.)

**Selecting text:** a clickable region holds the pointer from press to release, so the text
in a row's line can't be selected. A row's second line can (a command's exact text and where
its output went, a prompt group's prompt, what an agent is doing): it is plain text under the
region. So is an opened row's card, its figures, Flow and Context & cost: select it with the
mouse and copy it (⌘C in the desktop app). To copy what a row's line shows, open the row; its
card shows the same figures. Buttons can't be selected: **Copy command** and **Copy output**
copy a command and its output whole.

**Compacting the session:** a **Compact** button sits beside the context figure (`ctx 25%`)
in the header of every tab, and beside the Context meter in Overview's Session section.
Compacting is drastic, so it takes two presses: the first turns the label into **Click again
to compact** for 6 seconds, and a second press within that window compacts, as `/compact`
does. A double click counts as one press. While Claude is working the session can't be
compacted, and a toast says to try again when it's idle; a toast also says when a hook vetoed
it, or when it's done.

- **Overview**, in this order:
  - **Models & effort**: prompts, turns, requests and tool calls for each model and effort.
  - **Prompts**: your latest 2 prompts as small cards, each titled in blue, saying whether it
    runs or is done, with when you sent it, how long it took, its calls, failures, cost, its
    requests' tokens in and out, and the 5-hour window it used. Click a title to open its card on the Prompts tab, expanded (the whole prompt and its own calls,
    each a card that opens in place, the newest 40): the tab scrolls
    to it and edges it in the accent until your next click. **⌕ Find** finds it in the
    conversation (**↗ Jump** in the terminal, see Prompts). **All prompts** opens the Prompts
    tab.
  - **Agents**: how many work now and have finished and what they cost, with the working ones
    (else the latest) listed, each saying what it is doing; click one to open it.
  - **Most recent commands**: the last 5 calls to finish, newest first, titled in blue, with a
    faint rule between each and the next; click one to open it.
  - **Commands**: shell commands by **read / write / execute** (count, total, average,
    longest, failures).
  - **Running now**: how many calls run and agents work, then each running call with its CPU,
    memory, power and network; a finished call stays 5 seconds. Click one to open it.
  - **Session**: cost, context (with **Compact**), the 5-hour window and the other rate-limit
    windows (with when they reset), command outcomes, sources, files and lines changed, and
    commits. **Charts in Compute** opens the Compute tab.
  - **Heaviest commands**: the most energy, network, CPU and memory; click one to open it.
  - **By tool**: every tool's calls, total and average time, and failures, the most time
    first.
  - **Time spent**: time monitored, how long bytes were moving (and by whom), total tool-call
    time and summed agent working time.
  - **Artifacts**: the pages Claude published (a link each, version, times published) and the
    files it sent you, with **Reveal in Finder**.

  The live rates are the header's, above every tab, so Overview doesn't repeat them; the
  charts (internet, power and energy, the battery, CPU, memory, disk) are the Compute tab's.
- **Commands**: a card at the top sums the calls by **read / write / execute** (how many and
  the time they took) and says how many are live and failed, above the filters. Below, a card
  for each prompt that made calls, the newest prompt first. A card's header is the prompt's
  title, with when you sent it, how many calls it made, how many are running or failed, how
  long its work took and what it cost; its second line is the prompt itself. Click a header to
  close or open its group; its jump button brings the prompt into view in the conversation. A
  sub-agent's calls belong to the prompt it serves: the one its task quotes, else the one
  Claude was given last. Calls made before any prompt, or before the monitor loaded, sit in
  their own group. Within a group, every tool call (or
  only Bash commands) has an **R / W / X** badge, the time it started, and the model and
  effort level that ran it; its title, what it does, is blue so it stands out from the
  figures around it, and the calls sit a line apart. Opening a row shows a card of its own,
  edged in its status's colour: the full command, its figures as tiles (start and end times,
  model, effort, access class, duration, exit code, CPU, peak memory, energy, network and
  network time, disk), and its output (the last 80 lines, at most 20,000 characters; **Show
  full output** shows the last 30,000). You can filter by access class, status and text.
  A row also shows the call's tokens, in and out (`23k in · 400 out`): its share of the model
  request that read its output, split by output size, as the API reported them; none until a
  request has read it. It lists the newest 40; **Show more** asks for 50 more and says how many
  of them the pane can draw (`Show 8 more of 90`, see *How big a drawing may be*). When none
  would fit, or past that, a note says the newest fill the pane and the filters find older ones. Its **Context & cost** panel, edged and headed in Claude's orange, shows:
  - **Context**: about how many tokens its command and output take up, and their share of the
    context window.
  - **Tokens**: its share of that request's tokens, in (with how many of them were read from
    the prompt cache) and out: `23k in (20k cached) · 400 out`.
  - **Cost**: its share of the model request that read its output, split by output size, with
    that request's price, tokens and how many outputs it read.
  - **Its own tokens**: about how many tokens its output (in, as Claude reads it) and its call
    (out, as Claude wrote it) come to, and what they alone cost.
  - **Cost breakdown**: its share of the request's cost by the kind of token, a line each with
    the tokens, what they cost and their share of it: **Input tokens** (the prompt's new part),
    **Cache reads**, **Cache writes** (kept 5 minutes, or an hour at a higher price), **Output
    tokens**, and the **Total**, which is its Cost.
  - **This command used**: about how much of the 5-hour window it took
    (`≈ 0.042% of the 5-hour window`), beside **Window used** (`48% of 100%`), when it resets,
    and this session's spend in the window. The share is its cost times the window's percent
    per dollar: measured once the window rises while this session spends, else the rate
    learned in an earlier window (kept across sessions), else an upper bound (`< 0.09%`) while
    the window hasn't moved a step yet.

  Its **Flow** panel, edged and headed in purple, its arrows (← what led to it, → what came
  next) purple too, tells where the call sits in its loop:
  - the calls whose outputs Claude had read when it made this one, and what this call
    repeats from them;
  - when Claude read this call's output and what it wrote then;
  - the calls it made next, and whether each repeats something from this output (a path,
    file name, identifier or line number that appeared in the output and not in this call's
    own input).

  It also sums this up in a sentence, and each linked call has an **Open** button. A row's
  second line shows the command, then where its output went (`→ Edits register.tsx (used
  its output)`). Every Bash row and detail shows **peak memory** with its share of the Mac's
  RAM (`1.21 GB (7.0%)`), and a running command its memory now too; a command the sampler
  never saw (it ended inside 250 ms, or its shell couldn't be matched) says it wasn't measured,
  and other tools say they run inside Claude's own process.
- **Prompts** (key p): the prompts you sent in this session as cards, newest first, ten to a
  page: **Older ›** and **‹ Newer** move a page, and the line beside them says which you are
  on (`#95–#86 of 95`). A page is held to the drawing budget (see *How big a drawing may be*),
  so a page of very large cards may hold fewer. A click on a title on Overview opens the
  page that holds it, with the card open. An open card shows at most 20,000 characters of the
  prompt (**Copy prompt** copies all of it) and the newest of its calls that fit. The top row
  sums them all: how many, how long Claude worked, tool calls, cost, tokens and energy. Each card
  has its number, its title (bold, in the blue a command's title has), whether it is **Queued**,
  **Running**, **Done**, **Interrupted**, ended by an error or refused, and the opening of what
  you wrote (**Expand** shows more of it and its calls, as above, and its **Cost breakdown**:
  its requests' cost by the kind of token, sub-agents' included, as a command's card breaks
  down its share). Then its figures:
  - **Sent**, **Ended** and **Duration** (from sending to the end of its last work: its turn,
    its calls, the agents spawned for it), and **Claude worked** (its turns' own time, with
    how many turns a continuation added);
  - **Tool calls** (failed and running ones too), **Cost** (every model request made for it,
    sub-agents' included, at list prices), **Tokens** in (with how many were read from the
    prompt cache) and out, **Requests** and **Model**;
  - **Context**: its own requests' context, the latest one's size with its share of the
    context window and how much it grew since its first (`197k (20% of 1M) · +12k`);
  - **5-hour window** and **Weekly window**: how far each rose while it ran
    (`+1.2% (24.8% → 26.0%)`, a reset in between counted); under a step, its cost at the rate
    the session learned (`≈ 0.04%`) or `< 0.1%`. Other sessions running at the same time move
    the windows too. Overview's small cards show the 5-hour figure;
  - **Energy**, **CPU time** and **Network**: what the session's processes used from its start
    to its end, measured while the sampler runs;
  - **Files changed** and where it came **From** (typed, phone or web, the app; `into a
    running turn` for one Claude took in while it worked);
  - an **Agents** section when it used any: how many agents were spawned for it (`Agents 3 ·
    1 workflow`), then each one's name on a line of its own with its type, a workflow's agents
    indented under the workflow (the newest 25; the Agents tab lists them all). A past
    session's prompt names the agents and workflows its calls asked for;
  - the **Tools** its calls used, the most used first (`Bash ×3 · Edit ×2`).

  **Prompts typed while Claude works** wait (**Queued**). When the running turn takes one in
  (Claude Code folds it into the turn's next request), it gets a task of its own: it runs
  while that turn and the agents spawned for it work, and a sub-agent started for it, the
  one whose task quotes it, files its calls, requests and cost there rather than under the
  turn's prompt. One that isn't taken in runs as a turn of its own once the current one ends.

  **Finding a prompt in the conversation.** The engine can scroll only its own transcript,
  the terminal's fullscreen one; the desktop app draws its conversation itself, out of a
  plugin's reach ("transcript not scrollable here"). No link of the app reaches one message
  of a local session either: its links that carry a message (`…/project/chan_…?msg=cmsg_…`)
  are for Code projects' channel messages, and a local session's own link
  (`claude://claude.ai/epitaxy/local_…`) opens the session, keeping no message. So in the
  desktop app the button is **⌕ Find in conversation**: it copies the prompt's opening line
  and presses ⌘F, ⌘V and Return for you, so the app's own Find lands on it. The keys are sent
  through System Events only while Claude is the app in front, and only once macOS allows
  them for the app it holds responsible: in the desktop app that is **Claude Code**, the
  engine Claude runs (a bundle of its own under `~/Library/Application Support/Claude/claude-code/`),
  not Claude itself, since Claude starts the engine through its `disclaimer` helper. Until
  then a toast says to press ⌘F, then ⌘V, yourself, and which app to switch on; the Prompts
  tab shows a card with **Allow in System Settings…**, which has macOS list Claude Code under
  Privacy & Security → Accessibility (it may ask you itself), opens that list, copies the
  engine's path for the list's + button (⌘⇧G, paste) in case it isn't listed, and watches
  for the switch for three minutes: once it is on, the card goes. In the terminal it is **↗ Jump to
  prompt**, which scrolls to your message (or, when that row isn't drawn, to the first tool
  call of its reply) and says why when it can't. Either way it is a button, not a click on
  the card: the engine scrolls only for a press of yours. **Show its commands**
  opens the Commands tab with only its group open; **Copy prompt** copies it. Below,
  **Earlier in this project** lists the prompts of this project's other sessions, five to a
  page, with Older and Newer of its own and a share of the budget of its own. They are
  kept across sessions by the repository's main working tree, so every worktree of a
  repository shares one history. Those cards can be copied, but another session's
  conversation can't be scrolled to.

  **Titles.** A prompt's title starts as its first sentence. A prompt longer than a title
  is also sent to a small model (haiku) with a request for a 3 to 8 word title, which
  replaces it when it comes. That's one short request per prompt, billed to your account
  like any other. `/session-monitor summaries off` stops it, and titles then stay the first sentence.
  Only your own prompts are listed (typed, from the phone or web, or from the app), never a
  background task's notification or another session's message.
- **Compute** (key m): every chart of what the session's processes use. **Charts show** picks
  **Last 2 minutes** (a point a second) or **Whole session** (a point every 10 seconds, the
  step doubling as the session grows past an hour, so it stays light), and is remembered.
  - **Now**: a card per figure (CPU, memory, power, energy, download, upload, disk) with its
    value, a note (CPU time; memory's share of the RAM and its peak; totals) and a sparkline
    of the last two minutes.
  - **CPU** and **Memory**: charts with a grid and both axes labelled, the latest value in the
    legend. Over the whole session each point is the span's average, with its peak dashed.
  - **Power & energy**: the power chart, energy used summed over time (whole session), and
    the **Battery**: its charge over the session, when the session began and now, how much of
    the drop the work explains, and the same for each recent prompt.
  - **Internet**: down and up totals and rates, the download and upload chart, the whole
    Mac's rates, and a bar of who moved the bytes.
  - **Disk**: reads and writes over time.
  - **Where it went**: one bar each for CPU time, energy, network and memory now, split among
    the Claude engine, MCP servers, the commands you ran, short-lived helpers and this monitor.
  - **By prompt**: the energy each of the latest prompts used, with its CPU time, network and
    duration.
  - **Heaviest commands**: the commands that used the most energy, with their CPU and peak
    memory.

  The desktop app draws the charts as SVG in colours that read on light and dark themes; the
  terminal draws block-character sparklines and meters. Each chart is drawn at a fixed size
  that fits the pane: the app rebuilds every image when the figures change, and an image
  without a size has none until it loads, which shortened the page and pulled the scroll back
  to the top every couple of seconds.
- **Agents** (key a): the sub-agents, teammates, workflows and background shell commands the
  session started, like Claude's own Background tasks panel. A card at the top counts them
  (agents, workflows, background shells, how many work now, their tokens and cost). **Running
  now** comes first, then **Finished (N)**, newest first, each agent a card of its own, edged
  in its status's colour as a call's card is. Each card's row shows
  its status (a spinner while it works), how long it has run (or ran), its type, its name or
  task, the model and effort level of its latest request, its tokens (the latest request's
  size, as Claude counts an agent's tokens), and how many model requests and tool calls it
  made. A workflow shows how many agents it started and their summed tokens, requests and tool
  calls, with its agents' cards indented beneath it; a background shell nests under the agent
  that started it. A parent's card (a workflow's, or an agent's that started agents or shells)
  is edged in purple and shaded apart from the cards under it, and names what it started, one
  under another with each one's status and type, under how many (`4 agents`). Those cards are
  folded away until you expand the parent: press **▸ Expand their 4 cards**, or open the
  parent's card with a click. **▾ Collapse**, or closing the parent's card, folds them away
  again (the names stay); a card that is open keeps the parents above it expanded. Opening a
  card shows, inside it, its ids, the agent
  or workflow it belongs to, its figures as tiles (start and end times, tokens sent and
  received, and the rest below), its **Cost breakdown** (its requests' cost by the kind of
  token, a workflow's agents' added up), a workflow's phases, and the tool calls made inside it (a
  workflow's: its agents'), the newest first, drawn exactly as the Commands tab draws them:
  click one to open its card (output, flow, context and cost) right there. They come 20 to a
  page, as many of a page as the pane can draw: **Older ›** and **‹ Newer** move a page, and the
  line beside them says which you are on (`21–40 of 244`), so every call can be reached. The
  monitor keeps only the session's newest 400 calls, so opening a card also reads the agent's
  own transcript (Claude Code keeps one for each agent beside the session's, a workflow's
  agents' under its run) and adds the calls only it holds, with their outputs and token
  shares; the calls neither holds are counted. It also shows what the agent is
  **responsible for** (the opening of the prompt that started it, also the row's second line),
  what it is **doing now** (waiting on the model for request N, running a tool, between steps,
  answered, or ended, with how long), what it **last said**, how it was started and whether it
  is in Claude's agent list, its request and turn-end counts and last activity, every **run**
  of its loop with its start and end times, request count and how it ended, its **context**
  (the latest request's size against the window), its **cost**, and about how much of the
  **5-hour window** it used. The row shows its start time, cost and 5-hour share; a workflow
  sums its agents'.

  **Agents Claude Code starts itself** (prompt suggestions, forks) come without an Agent call,
  are never in Claude's agent list, and their end is never reported, so they would look
  running forever. Such an agent says so in its details. Once it has been quiet for a minute,
  and isn't waiting on the model or a tool, the monitor marks it **Done (end not
  reported)**; anything new from it brings it back. The tab's label counts every row and the ones working now
  (`Agents 5 · 2 live`), and Overview says how many are working. The mod reads Claude's agent
  list every 3 seconds while anything works or the tab is open, counts each agent's requests,
  tokens and tool calls as they happen, and learns a workflow has finished when Claude's turn
  ends without it among the background tasks still in flight.
- **Files**: every file the session **created (A), modified (M), deleted (D) or only read
  (R)**, with read and edit counts, the tools that touched it, and when it was last edited
  (or last read). Changes git sees that no
  Claude file tool made (a shell command's) are included. Opening a file shows the diff for
  files in the repository, or the current text for files outside it.
- **Explorer**: the project folder as VS Code's explorer shows it, where you can make, open,
  edit, rename and delete files and folders. See *The Explorer* below.
- **Commits**: uncommitted changes plus the commits for this session, this branch or the last
  30. Opening a commit shows its message and files, and opening a file shows its diff, either
  changes only or the whole file.

**Viewing code.** In the desktop app (and VS Code and mobile), an opened file or diff is drawn
the way an editor shows it, in VS Code's Dark+ colours:
- a title bar with the file's name, its folder, and its +/− counts or line count;
- a line-number gutter. A diff has two, the old file's numbers and the new file's;
- added lines tinted green with a `+`, removed lines tinted red with a `−`, and each `@@`
  hunk header on its own bar;
- syntax colours for Python, TypeScript/JavaScript, JSON, YAML, TOML, shell, Markdown and
  CSS, carried across lines, so a docstring or block comment stays coloured;
- a monospace font with indentation kept exactly, and long lines wrapped under the code
  column with a `↪`.

It is drawn as SVG, the only element whose font, colours and spacing the mod controls (the
desktop draws the engine's `Code` element as a plain block). A long file is split into pieces
stacked one under another. Past about 900,000 characters of drawing, the rest is left out and
counted; **Copy diff** / **Copy text** still copies all of it. The terminal keeps the
engine's own code view, which has its own gutters and colours.

**Selecting code.** In the desktop app you can select code in the view with the mouse and
copy it (⌘C, or right-click → Copy). Only the code is taken, never the line numbers, +/−
markers, hunk headers or title bar; a wrapped line copies as one line, with its
indentation. The desktop draws the view in frames for this (VS Code and the mobile app
still draw it as an image), so a selection stays within one part of a long file (about
200 lines); **Copy diff** / **Copy text** still copies everything. If ⌘C copies nothing
after the pane has redrawn, right-click → Copy still works.
- **Sources**: every website, page and search used. It shows totals, the latest searches with
  their result counts, and the URLs grouped by website, the busiest first, as clickable links
  (with HTTP status, size and time): fetched pages, URLs written in commands and browser
  navigations, as many as the pane draws, the rest counted. Then each MCP server called.
  There's a button to copy every URL, drawn or not.
- **Resources**: each process group under the session, with CPU, memory, power, energy,
  network, network time and CPU time, plus a command leaderboard.
- **Ports**: the dev servers you can turn on and off, every Claude Code session on this Mac
  with its process tree, and every TCP port something listens on. See below.
- **Cache** (key h): Claude's prompt cache for this session. Each request sends the whole
  conversation; the API serves the part sent before from its cache at a tenth of the input
  price, and every read keeps it alive as long again. Claude Code keeps the main loop's
  cache an hour (a write costs 2x the input price) and an agent's 5 minutes (1.25x). Read
  from the session's transcripts (`transcripts.py cache`, about 0.4 s), when the tab opens and
  every 30 seconds while it is open (**Refresh** reads at once). Its cards:
  - **Prompt cache**: how many tokens it holds now, how long it is kept, when it was last
    used and when it expires (counting down, amber in its last stretch, red once expired),
    what the next request pays to read it, or to write it all again once expired, the hit
    rate (the share of every prompt read from the cache), what reading and writing cost
    and what it saved against the input price, how many requests wrote it again, and how
    many times the session was compacted.
  - **What is in it**: since the session began or was last compacted, what the prompt began
    with (the system prompt, the tools and the compaction's summary or the first message)
    and what it took in since, by kind (tool outputs, the calls Claude wrote, the summary,
    Claude's replies, your prompts) sized from their text, and its biggest items (a log a
    command printed, a file a call wrote, a pasted prompt) with their share of the cache.
  - **Requests**: the latest, the newest first: what each read, wrote (kept 1h or 5m), sent
    new and wrote back; one that wrote most of its prompt again is flagged (the cache had
    expired, or its prompt changed: a compaction, another model).
  - **Agents' caches**: each agent's own, the most recently at work first: how big, kept how
    long, when it expires, its requests, hit rate and cost.

  The engine reports a request's cache writes without how long they are kept, so the
  monitor's live cost figures price them by what the transcripts showed: once a session's
  first turn ends it reads its transcript (once) for how much of the main loop's writes and
  of the agents' were kept an hour, keeps that for the sessions to come, and prices writes at
  1.25x or 2x the input rate by it (5 minutes, the API's default, until it knows). This tab
  prices each write at its own.

### Ports

`/session-monitor ports` (or the Ports tab, hotkey t) reads processes and ports with
`sampler/procs.py` (`ps` and `lsof`, about 0.3 s) every 3 seconds, and only while the tab is
open.

- **Dev servers**: :8133 (the trade analysis web app) and :8134 (its API, `task dev:api`),
  both run from `~/Trading/quant-trade-analysis`. Each row shows whether it is listening,
  stopped, starting, stopping or held by another program, with its pids, uptime, CPU and
  memory, a link, and a **Turn on** / **Turn off** button. The list is kept in the plugin's
  store under `devServers`, so you can add more servers (`port`, `name`, `cwd`, `command`,
  `url`).
  - The web app starts with `bun run --cwd apps/web next dev -p 8133`, which is its `dev`
    script (`task dev`) without `NODE_OPTIONS='--inspect=8133'`. That flag starts a Node
    debugger, and Next.js puts its worker's debugger on the next port, :8134, which is the
    API's. With it, starting the web app made the API's row look on and kept the API from
    starting. Settings saved with the old `task dev` are moved to the new command once.
  - A port held by another dev server's processes (the web app's debugger on :8134, say)
    shows as **held by** that server, not as on, with a **Restart … without the debugger**
    button that turns that server off and on again with its current command.
  - **Turn on** refuses if something already listens on the port, and names it. Otherwise it
    starts the command under `/bin/sh` in a session and process group of its own, so the
    server keeps running after the pane, the plugin or the Claude session ends. Then it checks
    every second, for up to 60 s, until the port listens. Its output goes to
    `~/.claude/session-monitor/logs/<port>.log`; click the row to see the last 40 lines.
  - **Turn off** sends SIGTERM to the listener's whole process group (the task runner, bun or
    node, uv and uvicorn with its reload watcher), waits up to 5 s, sends SIGKILL to whatever
    is left, and confirms the port is free. If that group also holds a Claude process (a
    server started from a Bash tool call can share Claude's group), only the listener and its
    own child processes are stopped.
- **Claude sessions**: every Claude Code process on this Mac, with this session marked, its
  folder, start time, CPU and memory, and the processes under it (MCP servers, shells, dev
  tools, the monitor's sampler), each with its state and the ports it listens on. Names are
  short and leave out anything that looks like a secret; full command lines are never shown.
- **Listening ports**: those of Claude sessions and dev servers first, then **Other apps**,
  collapsed, listed only.

Click a process row for **Suspend** (SIGSTOP) or **Resume** (SIGCONT), **Kill** (SIGTERM) and
**Force kill** (SIGKILL). Kill and Force kill need a second click within 6 seconds. Other
sessions' processes can be signalled. These can't, because they would take this session or
the pane down with them or aren't yours:

- this session's own Claude process and anything above it (which would end this session)
- pid 1 and below
- other users' processes
- the monitor's own sampler and helper

Just before signalling, the helper checks again that the pid still belongs to the same
process (its start time), so a pid that was reused is never hit.

**Sources by task.** Every source records which task used it. A task is a prompt you typed
(a turn that starts without typed text counts toward the prompt before it), a sub-agent, or
"Outside any prompt". A sub-agent is labelled with its type and the description from the
Agent call that started it, or from the agent list if that call hasn't finished yet. On the
Sources tab, set **View** to **By task** to list the tasks, newest first. Each row shows the
task's label, kind, start time, and how many searches, URLs, websites and failures it had.
Click a task to see its searches, the latest first, and its URLs as links, grouped by
website, the busiest first, as many as fit (see *How big a drawing may be*), the rest counted. The **Show**
filter works in both views. Tasks that used no web sources are hidden until you click "Show N
tasks without sources". The summary line counts how many tasks used the web, and
`/monitor-report` has a "Sources by task" section.

**Read, write, execute.** Read means it only looked (Read, Grep, `ls`, `git status`, …).
Write means it changed files (Write, Edit, redirects, `rm`, `mv`, `git commit`,
`npm install`, …). Execute means it ran a program (`pytest`, `python script.py`, `make`, …).
The engine's own read-only verdict is used when it gives one.

**The folder tree.** The Files tab has two views: **Activity** (every file the session
touched) and **Folder**, the session's working folder as a tree. Folders come first, then
files, each alphabetical. Every row shows its size (for a folder, the total of the files in
it, with `≥` when the count ran out of time), its permissions as `ls -l` prints them
(`drwxr-xr-x`, with **r**, **w** and **x** in their own colors) and when it last changed.
Click a folder to open it, and click it again to close it. Click a file to see its text,
with **Open in …** and **Reveal in Finder** buttons (see *Opening files* below). Hidden entries (names starting with a
dot) sit in a collapsed **Hidden (N)** group at the top of each folder. **Refresh** lists
the open folders again, which also happens on its own after Claude writes, edits or runs a
command while the tree is on screen. The tree never lists anything outside the working
folder or follows a symbolic link out of it. Big folders such as `.git`, `.venv` and
`node_modules` can't stall the pane, because each listing shows at most 400 entries and adds
up sizes for at most 1.5 seconds.

**The Explorer.** The Explorer tab (**e**, or `/session-monitor explorer`) shows the session's
working folder the way VS Code's explorer does: folders first, then files, each by name ignoring
case (`file2` before `file10`), hidden entries inline, and what git ignores (`.venv`,
`node_modules`, build output) drawn dim, with everything inside an ignored folder. `.git`,
`.DS_Store` and the other names VS Code leaves out by default are left out. A folder leads with
its arrow (▸ closed, ▾ open), a file with its type's icon (see *File icons*).

- **Read**: click a folder to open or close it; click a file to see its text in the code view.
  Either is selected (lit, with the accent bar), and its actions sit under it. Click a selected
  file again to let go of it.
- **Create**: **New file** and **New folder** over the tree make the entry in the selected folder
  (or the selected file's folder, or the project folder when nothing is selected); a folder's
  own **New file here** and **New folder here** make it in that folder. Type a name and press
  Enter or **Create**. A `/` makes the folders on the way (`src/utils/date.ts`). A new file opens
  in the editor.
- **Update**: **Edit** opens a file's text in an editor under its row; **Save** (or Enter) writes
  it. A new line is typed as in the prompt box (Shift+Enter). A file that uses Windows line ends
  keeps them. If the file changed on disk since you opened it (Claude edited it, say), the first
  Save only says so and turns into **Save over it**. **Close** with unsaved text asks for a
  second click (**Discard changes**). **Rename** gives an entry a new name in its folder; open
  folders, the selection and the editor follow it. Case-only renames (`readme.md` →
  `README.md`) work too.
- **Delete**: the first click turns the button into **Click again to delete**; a second click
  within 6 seconds moves the entry to the Trash with macOS's own `/usr/bin/trash`, so Finder's
  Put Back restores it (the Finder does it on a Mac without that command). A double click is one
  press, so it never deletes.
- Every entry also has **Reveal in Finder** and **Copy path**, and a file an **Open in …**
  button named for the app it opens in (see *Opening files*).

Nothing is made, written, renamed or deleted outside the project folder: not by a path spelled
with `..`, and not through a symbolic link that leads out of it. A name is never written over:
**Create** and **Rename** refuse a name that is taken. Links are shown (🔗) but never followed.

The editor needs Claude Code 2.1.308 or later, the first version known to draw a text field of
several lines; on an older one **Edit** is not offered (**Open in Cursor** edits the file) and the
rest works. It takes files up to 60,000 characters; a bigger or binary file opens in its app.
Each folder lists up to 500 entries (Open in Finder shows them all), and the tab draws as many
rows as the pane can (see *How big a drawing may be*). It lists its open folders again after
Claude writes, edits or runs a command while the tab is on screen, and on **Refresh**.

**Opening files.** A file's Open button, in the Explorer and in the Files tab's folder view,
names the app it opens in. Code, config, data and text files open in **Cursor**: Python,
JavaScript and TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`, …), JSON, CSV and TSV, Java, Kotlin,
Go, Rust, C and C++, Swift, shell scripts, SQL, YAML and TOML, CSS, Markdown, plain text and
logs, notebooks (`.ipynb`), lock files, dotfiles (`.gitignore`, `.env.local`) and files known
by name (`Dockerfile`, `Makefile`, `LICENSE`). Web pages (`.html`, `.htm`, `.xhtml`) open in
**Google Chrome**. Anything else (an image, a PDF, an archive, an SVG) opens in the app macOS
picks for it, and a folder in Finder. Where Cursor or Chrome cannot open a file (not
installed), its default app does, and a toast says so. The table is `hooks/lib/apps.ts`.

## How it measures

`sampler/sampler.py` is a small Python script that uses only the standard library. It walks
the Claude process tree every 250 ms and prints one JSON line a second.

| Figure | Source |
| --- | --- |
| CPU time, memory footprint, peak memory, disk bytes | `proc_pid_rusage` (rusage_info_v6) |
| Energy | the macOS kernel's per-process energy estimate (`ri_energy_nj`) |
| Network per process | `nettop -P -L 1 -x` (twice a second while a command runs) |
| Network time | the seconds in which a group's byte count grew between readings |
| Network for the whole Mac | `netstat -ib` |
| CPU for the whole Mac | `host_statistics` (HOST_CPU_LOAD_INFO): the busy share of every core's ticks between two readings a second apart |
| Memory for the whole Mac | `host_statistics64` (HOST_VM_INFO64) page counts: app (anonymous less purgeable), wired and compressed, as Activity Monitor's Memory Used; the RAM from `sysctl hw.memsize` |
| Latency | the time a TCP connect to `api.anthropic.com:443` takes, every 15 s on a thread of its own (3 s timeout), so a slow network never holds up a tick |
| Which shell is which Bash call | the command the shell runs, read from its argv |
| Sources | WebFetch and WebSearch results, browser tools' URLs, URLs in commands and MCP inputs |
| Battery | `ioreg -r -c AppleSmartBattery` (~10 ms) at the session's start, each prompt's start and end, and every minute |
| Model and effort | each model request (`turn.step`) names both; a tool call takes its request's |
| Folder tree | `sampler/tree.py`, one folder per run: `os.scandir` without following links, sizes within 1.5 s |
| Explorer | `$.fs.list`, one folder at a time; `git check-ignore --stdin -z` for what is ignored |
| Past sessions | `sampler/transcripts.py`: the project's transcripts listed at the start and every 5 minutes (each file's summary cached by its size and time), one read when it is chosen or the session reopens |
| An agent's calls | `sampler/transcripts.py agents`: the agent's own transcript (a workflow's: its agents'), read each time its card opens |
| Prompt cache | `sampler/transcripts.py cache`: the session's transcript and its agents', read when the Cache tab opens and every 30 s while it is open |
| Cost | each model request's token usage at list prices; a request's price is shared by the calls whose outputs it read, by output size |
| 5-hour window | the limit's percent used as each response reports it: the rise while this session spent, shared in proportion to spend |
| Artifacts | the Artifact tool's publish calls (the page's URL from the result) and SendUserFile's files |

Costs are estimates. They use list prices; fast mode and other discounts or surcharges are not
seen. A command's output size stands in for its share of a request. The 5-hour share counts the
limit's whole rise while this session spent, so other sessions running at the same time inflate
it. Context for a command is its characters ÷ 3.5.

Commands that finish between samples still get their CPU time, taken from what the Claude
process reaped. Their energy is then estimated from that CPU time and marked `≈`. Their
network and memory show as `—`, because they cannot be measured.

## Clicks

Each tab subscribes only to the values it shows. Commits, Files and Sources are not drawn
again while you read them. Overview, Compute and Resources update every 2 seconds. The whole row is the
click target, and lighting it under the pointer happens in the row itself, with no round trip
to the mod. A second press within 0.6 s counts as the same press, so a double click opens a
row once. Pressing a file while its diff is loading never closes it.

## Develop

Work on a copy, then copy it back, because every open session reads this folder:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
python3 -m unittest discover -s sampler
```

Then run `/reload-plugins` in a session.
