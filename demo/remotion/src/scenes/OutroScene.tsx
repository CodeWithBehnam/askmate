import { AbsoluteFill } from "remotion";
import { ObsidianWindow } from "../components/ObsidianWindow";
import { useEntrance } from "../components/Animation";
import { theme } from "../data/theme";

export const OutroScene = () => {
	const title = useEntrance(10);
	const windowStyle = useEntrance(26);

	return (
		<AbsoluteFill style={{ padding: 76 }}>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 650px", gap: 56, alignItems: "center", height: "100%" }}>
				<div style={{ ...windowStyle, transform: `${windowStyle.transform} scale(0.78)`, transformOrigin: "left center" }}>
					<ObsidianWindow mode="final" />
				</div>
				<div style={title}>
					<div style={{ fontSize: 94, fontWeight: 950, lineHeight: 0.96 }}>AskMate</div>
					<div style={{ color: theme.muted, fontSize: 38, lineHeight: 1.2, marginTop: 28 }}>
						Your notes stay in Obsidian. AI helps where you already work.
					</div>
					<div
						style={{
							marginTop: 42,
							display: "inline-flex",
							borderRadius: 14,
							background: `linear-gradient(135deg, ${theme.purple}, ${theme.cyan}, ${theme.green})`,
							color: "#FFFFFF",
							fontSize: 24,
							fontWeight: 950,
							padding: "18px 24px",
						}}
					>
						github.com/CodeWithBehnam/askmate
					</div>
				</div>
			</div>
		</AbsoluteFill>
	);
};
