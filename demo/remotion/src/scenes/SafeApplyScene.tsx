import { AbsoluteFill } from "remotion";
import { ObsidianWindow } from "../components/ObsidianWindow";
import { useEntrance } from "../components/Animation";
import { theme } from "../data/theme";

export const SafeApplyScene = () => {
	const windowStyle = useEntrance(8);
	const label = useEntrance(24);

	return (
		<AbsoluteFill style={{ padding: "62px 86px" }}>
			<div style={{ ...label, display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 26 }}>
				<div>
					<div style={{ color: theme.amber, fontSize: 30, fontWeight: 900, marginBottom: 12 }}>
						Safe Apply
					</div>
					<div style={{ fontSize: 58, lineHeight: 1.04, fontWeight: 950 }}>
						Review edits before they touch the vault.
					</div>
				</div>
				<div style={{ color: theme.muted, fontSize: 24, fontWeight: 800, maxWidth: 520, lineHeight: 1.25 }}>
					AskMate can replace selected text, but the diff makes the change explicit first.
				</div>
			</div>
			<div style={{ ...windowStyle, transform: `${windowStyle.transform} scale(1.02)`, transformOrigin: "top left" }}>
				<ObsidianWindow mode="diff" highlightSelection />
			</div>
		</AbsoluteFill>
	);
};
