// A title drawn as a `Client` region, so a click on it opens what it names:
// a prompt's on Overview opens its card on the Prompts tab. The surface hands
// the region every pointer event, and the title posts what it opens back to
// the hooks module (`ui.message`), as a list row does (view/row.tsx). Runs on
// the drawing thread, without `$`; everything it shows arrives as props.

import type { ClientModule } from 'claude-code'

import { hearTabKeys } from '../lib/hotkeys'

/** What a title opens: a prompt of this session, its card on the Prompts tab; or a parent agent's fold, its children's cards shown or folded away. */
export type TitlePress = { kind: 'prompt'; id: string } | { kind: 'fold'; id: string } | { kind: 'expand'; id: string }

/** Every field is set (props are JSON). */
export type TitleLinkProps = {
  press: TitlePress
  text: string
  /** The text's colour; '' for the text colour. */
  color: string
  bold: boolean
}

type TitleLinkState = { isHovered: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a title posted, when it is a title's press: the id of the prompt it opens. */
export const readTitlePress = (data: unknown): string | undefined =>
  isRecord(data) && data.kind === 'prompt' && typeof data.id === 'string' ? data.id : undefined

/** What a prompt card's Expand posted, when it is one: the id of the prompt whose card it opens or closes. */
export const readExpandPress = (data: unknown): string | undefined =>
  isRecord(data) && data.kind === 'expand' && typeof data.id === 'string' ? data.id : undefined

/** What a fold posted, when it is one: the id of the parent agent whose children's cards it shows or folds away. */
export const readFoldPress = (data: unknown): string | undefined =>
  isRecord(data) && data.kind === 'fold' && typeof data.id === 'string' ? data.id : undefined

const TitleLink: ClientModule<TitleLinkProps, TitleLinkState> = (props, surface) => {
  const { Box, Text } = surface.elements
  // A tab's letter opens it while the title holds the focus, as everywhere in the pane.
  hearTabKeys(surface)
  // Set on every call, so a click posts what the props say now.
  const press = props.press
  surface.onPointer(event => {
    const isInside =
      event.x >= 0 && event.y >= 0 && (surface.columns === 0 || event.x < surface.columns) && (surface.rows === 0 || event.y < surface.rows)
    const wasHovered = surface.state?.isHovered === true
    if (event.type === 'up' && event.button === 'left' && isInside) {
      surface.post(press)
    } else if (event.type === 'enter' || (event.type === 'move' && event.button === undefined && isInside)) {
      if (!wasHovered) {
        surface.setState({ isHovered: true })
      }
    } else if ((event.type === 'leave' || (event.type === 'move' && !isInside)) && wasHovered) {
      surface.setState({ isHovered: false })
    }
  })
  if (surface.state === undefined) {
    surface.setState({ isHovered: false })
  }
  // Underlined under the pointer, as a link is.
  const isHovered = surface.state?.isHovered === true
  return (
    <Box key="title" flexDirection="row">
      <Text color={props.color === '' ? undefined : props.color} bold={props.bold} underline={isHovered} hover={{ underline: true }}>
        {props.text}
      </Text>
    </Box>
  )
}

export default TitleLink
