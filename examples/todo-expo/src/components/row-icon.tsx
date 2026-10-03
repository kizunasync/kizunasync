import Svg, { Path } from 'react-native-svg'
import { ROW_ICON_PATHS, type TRowIconName } from '@kizunasync/ui'

/** One Material row-action glyph from the shared path table, drawn in `color`. */
export function RowIcon({ name, color, size }: { name: TRowIconName; color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={ROW_ICON_PATHS[name]} fill={color} />
    </Svg>
  )
}
