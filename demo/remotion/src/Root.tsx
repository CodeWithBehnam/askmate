import { Composition, Still } from "remotion";
import { AskMateDemo } from "./AskMateDemo";
import { Thumbnail } from "./Thumbnail";

export const FPS = 30;
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_DURATION_FRAMES = 75 * FPS;

export const RemotionRoot = () => {
	return (
		<>
			<Composition
				id="AskMateProductDemo"
				component={AskMateDemo}
				durationInFrames={VIDEO_DURATION_FRAMES}
				fps={FPS}
				width={VIDEO_WIDTH}
				height={VIDEO_HEIGHT}
			/>
			<Still id="AskMateThumbnail" component={Thumbnail} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} />
		</>
	);
};
