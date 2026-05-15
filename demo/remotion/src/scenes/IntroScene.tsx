import { AbsoluteFill } from "remotion";
import { ObsidianWindow } from "../components/ObsidianWindow";
import { useEntrance } from "../components/Animation";
import { theme } from "../data/theme";

export const IntroScene = () => {
	const title = useEntrance(6);
	const windowStyle = useEntrance(30);

	return (
		<AbsoluteFill style={{ padding: 72 }}>
			<div style={{ display: "grid", gridTemplateColumns: "520px 1fr", alignItems: "center", gap: 58, height: "100%" }}>
				<div style={title}>
					<div style={{ color: "#159A83", fontSize: 30, fontWeight: 900, marginBottom: 18 }}>
						Real AskMate UI demo
					</div>
					<div style={{ fontSize: 100, fontWeight: 950, lineHeight: 0.95, letterSpacing: 0 }}>
						AskMate
					</div>
					<div style={{ color: theme.muted, fontSize: 34, lineHeight: 1.22, marginTop: 26 }}>
						AI Q&A, summaries, workflows, safe note edits, and images inside Obsidian.
					</div>
				</div>
				<div style={{ ...windowStyle, transform: `${windowStyle.transform} scale(0.86)`, transformOrigin: "left center" }}>
					<ObsidianWindow mode="idle" />
				</div>
			</div>
		</AbsoluteFill>
	);
};
