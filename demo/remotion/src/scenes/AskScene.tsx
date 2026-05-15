import { AbsoluteFill, Sequence } from "remotion";
import { ObsidianWindow } from "../components/ObsidianWindow";
import { useEntrance } from "../components/Animation";
import { theme } from "../data/theme";

export const AskScene = () => {
	const headline = useEntrance(4);
	const windowStyle = useEntrance(20);

	return (
		<AbsoluteFill style={{ padding: "64px 86px" }}>
			<div style={{ ...headline, fontSize: 54, fontWeight: 950, marginBottom: 26, color: "#20242B" }}>
				Ask about the note you are already reading.
			</div>
			<div style={{ ...windowStyle, transform: `${windowStyle.transform} scale(1.05)`, transformOrigin: "top left" }}>
				<Sequence durationInFrames={155}>
					<ObsidianWindow mode="typing" />
				</Sequence>
				<Sequence from={155}>
					<ObsidianWindow mode="summary" />
				</Sequence>
			</div>
			<div
				style={{
					position: "absolute",
					right: 86,
					bottom: 58,
					color: theme.muted,
					fontSize: 26,
					fontWeight: 800,
				}}
			>
				Selected text or full note context, visible before sending.
			</div>
		</AbsoluteFill>
	);
};
