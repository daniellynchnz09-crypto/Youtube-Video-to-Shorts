import { Composition } from 'remotion'
import { ShortClip, shortClipPropsSchema, type ShortClipProps } from './ShortClip.js'

const FPS = 30

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ShortClip"
      component={ShortClip}
      schema={shortClipPropsSchema}
      fps={FPS}
      width={1080}
      height={1920}
      durationInFrames={FPS * 20}
      defaultProps={{
        videoSrc: '',
        title: '',
        words: [],
        durationInSeconds: 20
      } satisfies ShortClipProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.round(props.durationInSeconds * FPS))
      })}
    />
  )
}
