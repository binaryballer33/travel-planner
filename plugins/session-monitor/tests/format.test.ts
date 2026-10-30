import { describe, expect, test } from 'claude-code/testing'

import {
  churn,
  fmtBytes,
  fmtClock,
  fmtCpuSeconds,
  fmtDuration,
  fmtEffort,
  fmtEnergy,
  fmtMemory,
  fmtMemShare,
  fmtRate,
  fmtTokens,
  memShare,
  fmtWatts,
  meter,
  oneLine,
  sanitize,
  shortModel,
  sparkline,
  statusGlyph,
  statusTone,
  toneCpu,
  toneEnergy,
  toneNetTotal,
  toneRate,
} from '../hooks/lib/format'
import { jumpLabel } from '../hooks/view/kit'

describe('sanitize', () => {
  test('strips ANSI colors, carriage returns and control characters', () => {
    expect(sanitize('\u001b[31mred\u001b[0m\r\nnext\u0007 line\ttab')).toBe('red\nnext line\ttab')
  })

  test('oneLine cuts to the first line and marks what follows', () => {
    expect(oneLine('git status\ngit diff', 40)).toBe('git status …')
    expect(oneLine('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('units', () => {
  test('bytes use decimal units', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(999)).toBe('999 B')
    expect(fmtBytes(1_500)).toBe('1.50 kB')
    expect(fmtBytes(10_485_760)).toBe('10.5 MB')
    expect(fmtBytes(2_300_000_000)).toBe('2.30 GB')
    expect(fmtRate(250_000)).toBe('250 kB/s')
  })

  test('durations step from milliseconds to hours', () => {
    expect(fmtDuration(340)).toBe('340ms')
    expect(fmtDuration(2_400)).toBe('2.4s')
    expect(fmtDuration(65_000)).toBe('1m 05s')
    expect(fmtDuration(3_720_000)).toBe('1h 02m')
    expect(fmtCpuSeconds(0.04)).toBe('40ms')
  })

  test('energy shows watt-hours once large and watts below one as milliwatts', () => {
    expect(fmtEnergy(0.25)).toBe('250 mJ')
    expect(fmtEnergy(12.3)).toBe('12 J')
    expect(fmtEnergy(7200)).toBe('7.2 kJ (2.00 Wh)')
    expect(fmtWatts(0.061)).toBe('61 mW')
    expect(fmtWatts(4.2)).toBe('4.20 W')
  })
})

describe('charts', () => {
  test('sparkline scales to its maximum and keeps the last values', () => {
    expect(sparkline([0, 1, 2, 4], 4)).toBe('▁▃▅█')
    expect(sparkline([9, 0, 0], 2)).toBe('▁▁')
    expect(sparkline([], 4)).toBe('')
  })

  test('meter and churn fill their width', () => {
    expect(meter(0.5, 4)).toBe('██░░')
    expect(meter(2, 3)).toBe('███')
    expect(churn(3, 1, 5)).toEqual({ plus: '■■■', minus: '■', rest: '·' })
    expect(churn(100, 1, 5)).toEqual({ plus: '■■■■', minus: '■', rest: '' })
    expect(churn(0, 0, 3)).toEqual({ plus: '', minus: '', rest: '···' })
  })
})

describe('colors', () => {
  test('scales go green, amber, red', () => {
    expect(toneCpu(10)).toBe('success')
    expect(toneCpu(50)).toBe('warning')
    expect(toneCpu(250)).toBe('error')
    expect(toneRate(50_000)).toBe('success')
    expect(toneRate(500_000)).toBe('warning')
    expect(toneRate(5_000_000)).toBe('error')
    expect(toneNetTotal(60e6)).toBe('error')
    expect(toneEnergy(3)).toBe('success')
    expect(toneEnergy(80)).toBe('error')
  })

  test('idle values read as subtle', () => {
    expect(toneCpu(0)).toBe('subtle')
    expect(toneRate(0)).toBe('subtle')
  })

  test('statuses have a glyph and a tone each', () => {
    expect(statusGlyph('ok', 0)).toBe('✓')
    expect(statusGlyph('error', 0)).toBe('✗')
    expect(statusGlyph('running', 1)).toBe('⠙')
    expect(statusTone('error')).toBe('error')
    expect(statusTone('running')).toBe('warning')
  })
})

describe('tokens, clocks and models', () => {
  test('tokens step from units to k to M, never 1000k', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1_500)).toBe('1.5k')
    expect(fmtTokens(12_500)).toBe('13k')
    expect(fmtTokens(590_000)).toBe('590k')
    expect(fmtTokens(999_999)).toBe('1M')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
  })

  test('clock times are 12-hour with AM/PM, the date shown only when it is not today', () => {
    const now = new Date(2026, 9, 13, 23, 0, 0).getTime()
    expect(fmtClock(new Date(2026, 9, 13, 14, 32, 5).getTime(), now)).toBe('2:32:05 PM')
    expect(fmtClock(new Date(2026, 9, 13, 0, 7, 9).getTime(), now)).toBe('12:07:09 AM')
    expect(fmtClock(new Date(2026, 9, 13, 12, 0, 0).getTime(), now)).toBe('12:00:00 PM')
    expect(fmtClock(new Date(2026, 9, 13, 11, 59, 59).getTime(), now)).toBe('11:59:59 AM')
    expect(fmtClock(new Date(2026, 9, 12, 9, 5, 0).getTime(), now)).toBe('Oct 12 9:05 AM')
    expect(fmtClock(new Date(2026, 9, 12, 21, 40, 0).getTime(), now)).toBe('Oct 12 9:40 PM')
  })

  test('model names and effort levels read short', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('claude-haiku-5-5-20261001')).toBe('Haiku 5.5')
    expect(shortModel('gpt-x')).toBe('gpt-x')
    expect(fmtEffort('xhigh')).toBe('xhigh')
    expect(fmtEffort(undefined)).toBe('default')
    expect(fmtEffort(32_000)).toBe('32k budget')
  })
})

describe('memory and its share of the RAM', () => {
  test('the bytes with their share of the RAM; the bytes alone while the RAM is not known', () => {
    const ram = 16 * 1024 ** 3
    expect(memShare(1.21e9, ram)?.toFixed(2)).toBe('7.04')
    expect(memShare(1e9, 0)).toBeUndefined()
    expect(fmtMemory(1.21e9, ram)).toBe('1.21 GB (7.0%)')
    expect(fmtMemory(4.3e9, ram)).toBe('4.30 GB (25%)')
    expect(fmtMemory(1.21e9, 0)).toBe('1.21 GB')
    expect(fmtMemory(0, ram)).toBe('0 B')
  })

  test('a sliver of the RAM reads <0.1%, never 0.0% as if it held nothing; a share that rounds to 0.1% reads so', () => {
    // 34.2 MB of a 128 GB Mac is 0.025% of it.
    expect(fmtMemory(34.2e6, 128 * 1024 ** 3)).toBe('34.2 MB (<0.1%)')
    expect(fmtMemory(9e6, 16 * 1024 ** 3)).toBe('9.00 MB (0.1%)')
    expect(fmtMemShare(0.049)).toBe('<0.1%')
    expect(fmtMemShare(0.05)).toBe('0.1%')
    expect(fmtMemShare(0.4)).toBe('0.4%')
    expect(fmtMemShare(7.04)).toBe('7.0%')
    expect(fmtMemShare(25)).toBe('25%')
    expect(fmtMemShare(0)).toBe('0%')
  })
})

describe('the jump to a prompt', () => {
  test('a jump in the terminal, a Find in the desktop app, whose conversation no plugin can scroll', () => {
    expect(jumpLabel('terminal')).toBe('↗ Jump to prompt')
    expect(jumpLabel('terminal', true)).toBe('↗ Jump')
    expect(jumpLabel('desktop')).toBe('⌕ Find in conversation')
    expect(jumpLabel('desktop', true)).toBe('⌕ Find')
  })
})
