// The effort slider on Overview: Faster at one end, Smarter at the other,
// a stop for each level with its name under it, and a knob at the level set.
// Drawn as a `Client` region, so a press or a drag along it picks the stop
// under the pointer and posts it to the hooks module (`ui.message`), which
// runs `/effort`. Runs on the drawing thread, without `$`; everything it shows
// arrives as props.

import type { ClientModule } from 'claude-code'

import { hearTabKeys } from '../lib/hotkeys'

import { EFFORT_LEVELS, effortIndex, effortName, levelAt, type EffortPress } from '../lib/effort'

/** Every field is set (props are JSON). */
export type EffortSliderProps = {
  /** The level set now (`/effort`'s, else the latest request's); '' before any is known. */
  level: string
  /** Drawn for the terminal: the track in line characters, not shaded boxes. */
  isTerminal: boolean
}

/** The knob's stop while a drag is under way; null at rest. */
type EffortSliderState = { dragged: number | null }

/** The track, the part of it up to the knob, the knob, and the knob's level name. */
export const SLIDER_TRACK = '#7f7f7f2e'
export const SLIDER_FILL = '#58a6ff38'
export const SLIDER_KNOB = '#c9d1d9'
export const SLIDER_ACCENT = '#58a6ff'

const EffortSlider: ClientModule<EffortSliderProps, EffortSliderState> = (props, surface) => {
  const { Box, Text } = surface.elements
  // A tab's letter opens it while the slider holds the focus, as everywhere in the pane.
  hearTabKeys(surface)
  const width = surface.columns
  surface.onPointer(event => {
    const isInside = event.y >= 0 && (surface.rows === 0 || event.y < surface.rows)
    const index = effortIndex(levelAt(event.x, width))
    if (event.type === 'down' && event.button === 'left' && isInside) {
      surface.setState({ dragged: index })
    } else if (event.type === 'move' && event.button === 'left' && surface.state?.dragged !== null && surface.state?.dragged !== undefined) {
      if (surface.state.dragged !== index) {
        surface.setState({ dragged: index })
      }
    } else if (event.type === 'up' && event.button === 'left') {
      const wasDragging = surface.state?.dragged !== null && surface.state?.dragged !== undefined
      surface.setState({ dragged: null })
      if (isInside || wasDragging) {
        const press: EffortPress = { kind: 'effort', level: levelAt(event.x, width) }
        surface.post(press)
      }
    } else if (event.type === 'leave' && surface.state?.dragged !== null && surface.state?.dragged !== undefined && event.button === undefined) {
      surface.setState({ dragged: null })
    }
  })
  if (surface.state === undefined) {
    surface.setState({ dragged: null })
  }
  const dragged = surface.state?.dragged ?? null
  const shown = dragged ?? effortIndex(props.level)
  const stops = EFFORT_LEVELS.map((level, index) => {
    const isKnob = index === shown
    const isFilled = shown >= 0 && index < shown
    if (props.isTerminal) {
      return (
        <Box key={`stop:${level}`} flexGrow={1} flexShrink={1} width={1} minWidth={0} justifyContent="center" overflow="hidden">
          <Text color={isKnob ? SLIDER_ACCENT : isFilled ? SLIDER_ACCENT : 'subtle'} bold={isKnob}>
            {isKnob ? '━━●━━' : isFilled ? '━━━━━' : '──·──'}
          </Text>
        </Box>
      )
    }
    return (
      <Box
        key={`stop:${level}`}
        flexGrow={1}
        flexShrink={1}
        width={1}
        minWidth={0}
        justifyContent="center"
        alignItems="center"
        backgroundColor={isFilled || isKnob ? SLIDER_FILL : undefined}
        paddingY={0}
      >
        {isKnob ? (
          <Box backgroundColor={SLIDER_KNOB} paddingX={1}>
            <Text color="#1f2328" bold>
              {'│'}
            </Text>
          </Box>
        ) : (
          <Text color={isFilled ? SLIDER_ACCENT : 'subtle'}>·</Text>
        )}
      </Box>
    )
  })
  return (
    <Box key="effort" flexDirection="column" rowGap={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>Faster</Text>
        <Text dimColor>Smarter</Text>
      </Box>
      <Box flexDirection="row" backgroundColor={props.isTerminal ? undefined : SLIDER_TRACK} paddingY={props.isTerminal ? 0 : 0}>
        {stops}
      </Box>
      <Box flexDirection="row">
        {EFFORT_LEVELS.map((level, index) => (
          <Box key={`name:${level}`} flexGrow={1} flexShrink={1} width={1} minWidth={0} justifyContent="center" overflow="hidden">
            <Text color={index === shown ? SLIDER_ACCENT : undefined} dimColor={index !== shown} bold={index === shown}>
              {effortName(level)}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export default EffortSlider
