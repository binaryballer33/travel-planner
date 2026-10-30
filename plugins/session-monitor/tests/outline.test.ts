import { describe, expect, test } from 'claude-code/testing'

import { commandOutline, dropHeredocs, OUTLINE_CHARS, outlineParts, simpleCommands } from '../hooks/lib/outline'

describe("a shell command's outline", () => {
  test('the programs in order, each once, a quoted argument never split', () => {
    expect(commandOutline('cd ~/gov/03_market_and_pricing && ls; python3 -c "import csv; print(1)" | head -20')).toBe('cd · ls · python3 -c · head')
    expect(commandOutline('tail -5 /tmp/a.output; echo "---"; tail -15 /tmp/b.output')).toBe('tail · echo')
    expect(commandOutline('cat /tmp/x.output | head -80')).toBe('cat · head')
  })

  test('an interpreter shows its script, its -c or its -m module', () => {
    expect(commandOutline('cd "/Users/me/skills/gov" && python3 -u scripts/fetch_gsa_rates.py --notice-id 36C24427R0001 --staff "Project Manager:1:0.5"')).toBe('cd · python3 fetch_gsa_rates.py')
    expect(commandOutline('.venv/bin/python -m pytest -m "not data"')).toBe('python -m pytest')
    expect(commandOutline('node -e "console.log(1)"')).toBe('node -e')
  })

  test('variables it sets, and loops', () => {
    expect(commandOutline('W=$(pwd); for f in *.csv; do wc -l "$f"; done')).toBe('W= · pwd · for loop · wc')
    expect(commandOutline('export PATH=/x:$PATH; n=0; while read line; do n=$((n+1)); done < in.txt')).toBe('PATH= · n= · while loop · read')
    expect(commandOutline('if [ -f a ]; then rm a; else touch a; fi')).toBe('[ · rm · touch')
  })

  test("a heredoc's body is text, not commands; a redirection is not a separator", () => {
    const commit = "cd ~/mod && tsc -p . && claude plugin test . 2>&1 | tail -2 && git commit -q -F - <<'EOF'\nfeat: add things; rm -rf nothing\n- more | text\nEOF\ngit push -q origin main"
    expect(commandOutline(commit)).toBe('cd · tsc · claude · tail · git')
    expect(dropHeredocs(commit)).not.toContain('rm -rf')
    expect(commandOutline('make build &> build.log & sleep 1')).toBe('make · sleep')
  })

  test('prefixes and paths give way to the program', () => {
    expect(commandOutline('sudo env -i /usr/local/bin/gh pr list')).toBe('gh')
    expect(commandOutline('time nohup ./run.sh > out.log')).toBe('run.sh')
    expect(simpleCommands('a "b c" d\\ e')).toEqual([['a', 'b c', 'd e']])
  })

  test('a long outline is cut between parts, and an empty command has none', () => {
    const many = Array.from({ length: 80 }, (_, at) => `tool${at}`).join(' && ')
    expect(commandOutline(many).length).toBeLessThanOrEqual(OUTLINE_CHARS + 4)
    expect(commandOutline(many).endsWith('· …')).toBe(true)
    expect(outlineParts(many).every(part => /^tool\d+$/.test(part.text))).toBe(true)
    expect(commandOutline('')).toBe('')
  })
})

describe("an outline's parts", () => {
  test('each says what it is: a program, a variable it sets, or a loop', () => {
    expect(outlineParts('W=$(pwd); for f in *.csv; do wc -l "$f"; done; case $x in a) echo;; esac')).toEqual([
      { text: 'W=', kind: 'variable' },
      { text: 'pwd', kind: 'program' },
      { text: 'for loop', kind: 'loop' },
      { text: 'wc', kind: 'program' },
      { text: 'case', kind: 'loop' },
      { text: 'echo', kind: 'program' },
    ])
  })
})
