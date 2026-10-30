import { describe, expect, test } from 'claude-code/testing'

import type { BatteryReading } from '../types'
import { attribute, mahToJ, parseIoreg, signed64, systemWatts } from '../hooks/lib/battery'
import { effortText, recordStep, recordToolCall } from '../hooks/lib/models'

const T0 = 1_760_000_000_000

const IOREG = `+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "TimeRemaining" = 85
      "Amperage" = 18446744073709550656
      "CurrentCapacity" = 21
      "AppleRawCurrentCapacity" = 1445
      "ExternalConnected" = No
      "MaxCapacity" = 100
      "IsCharging" = No
      "Voltage" = 11126
      "AppleRawMaxCapacity" = 7097
      "BatteryData" = {"Voltage"=1,"CycleCount"=2}
    }
`

const reading = (extra: Partial<BatteryReading>): BatteryReading => ({
  t: T0,
  percent: 50,
  mah: 3_500,
  maxMah: 7_000,
  mv: 11_000,
  ma: -900,
  isCharging: false,
  isExternal: false,
  sessionJ: 0,
  ...extra,
})

describe('battery readings', () => {
  test('parse the registers, signed amperage included', () => {
    expect(signed64('18446744073709550656')).toBe(-960)
    expect(signed64('512')).toBe(512)
    expect(parseIoreg(IOREG, T0, 12)).toEqual({
      t: T0,
      percent: 21,
      mah: 1_445,
      maxMah: 7_097,
      mv: 11_126,
      ma: -960,
      isCharging: false,
      isExternal: false,
      minutesLeft: 85,
      sessionJ: 12,
    })
    expect(parseIoreg('', T0, 0)).toBeNull()
  })

  test('the draw in watts and energy in joules', () => {
    expect(systemWatts(reading({ ma: -1_000, mv: 12_000 }))).toBe(12)
    expect(systemWatts(reading({ ma: 500 }))).toBe(0)
    expect(mahToJ(1_000, 10_000)).toBe(36_000)
  })
})

describe('attributing a drop', () => {
  test('the share of the drain the session work explains', () => {
    // 100 mAh at 11 V is 3960 J; the work used 990 J of it.
    const result = attribute(reading({ sessionJ: 10 }), reading({ t: T0 + 600_000, percent: 49, mah: 3_400, sessionJ: 1_000 }))
    expect(result.state).toBe('measured')
    expect(result.minutes).toBe(10)
    expect(result.dropPct).toBe(1)
    expect(result.drainJ).toBe(3_960)
    expect(result.workJ).toBe(990)
    expect(result.sharePct).toBe(25)
    expect(Math.round(result.workBatteryPct * 1000) / 1000).toBe(0.357)
  })

  test('nothing is attributable on the adapter, or before any charge was lost', () => {
    expect(attribute(reading({}), reading({ isExternal: true, mah: 3_000 })).state).toBe('on-power')
    expect(attribute(reading({}), reading({ t: T0 + 20_000 })).state).toBe('too-short')
    expect(attribute(reading({}), reading({ mah: 3_000, sessionJ: 1e9 })).sharePct).toBe(100)
  })
})

describe('models and effort', () => {
  test('count requests, turns, prompts and tool calls per model and effort', () => {
    let list = recordStep([], { model: 'claude-opus-5-5', effort: 'xhigh', isTurnStart: true, isPrompt: true, isAgent: false })
    list = recordStep(list, { model: 'claude-opus-5-5', effort: 'xhigh', isTurnStart: false, isPrompt: false, isAgent: false })
    list = recordStep(list, { model: 'claude-opus-5-5', effort: 'xhigh', isTurnStart: true, isPrompt: false, isAgent: false })
    list = recordStep(list, { model: 'claude-haiku-5-5', effort: 'low', isTurnStart: true, isPrompt: false, isAgent: true })
    list = recordToolCall(list, 'claude-opus-5-5', 'xhigh')
    expect(list).toEqual([
      { model: 'claude-opus-5-5', effort: 'xhigh', turns: 2, prompts: 1, requests: 3, toolCalls: 1, agentRequests: 0 },
      { model: 'claude-haiku-5-5', effort: 'low', turns: 0, prompts: 0, requests: 0, toolCalls: 0, agentRequests: 1 },
    ])
    expect(effortText(undefined)).toBe('default')
    expect(effortText(8_000)).toBe('8000')
  })
})
