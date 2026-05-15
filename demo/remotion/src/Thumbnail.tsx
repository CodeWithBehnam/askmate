import { AbsoluteFill } from "remotion";
import { ObsidianWindow } from "./components/ObsidianWindow";
import { fontFamily, theme } from "./data/theme";

export const Thumbnail = () => {
	return (
		<AbsoluteFill
			style={{
				background:
					"linear-gradient(135deg, #F7F8FA 0%, #E7ECF5 56%, #F8FAFC 100%)",
				fontFamily,
				color: theme.text,
				padding: 76,
			}}
		>
			<div style={{ display: "grid", gridTemplateColumns: "790px 1fr", alignItems: "center", gap: 54, height: "100%" }}>
				<div>
					<div style={{ color: "#159A83", fontSize: 32, fontWeight: 850, marginBottom: 18 }}>
						Real AskMate UI demo
					</div>
					<div style={{ fontSize: 118, fontWeight: 950, lineHeight: 0.92, letterSpacing: 0 }}>
						AskMate
					</div>
					<div style={{ color: "#68707C", fontSize: 42, lineHeight: 1.22, marginTop: 28 }}>
						AI Q&A, summaries, workflows, and safe note edits inside Obsidian.
					</div>
				</div>
				<div style={{ width: 1240, transform: "scale(0.69)", transformOrigin: "left center" }}>
					<ObsidianWindow mode="summary" />
				</div>
			</div>
		</AbsoluteFill>
	);
};
