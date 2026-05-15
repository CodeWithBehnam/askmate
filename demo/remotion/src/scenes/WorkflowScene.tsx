import { AbsoluteFill } from "remotion";
import { ObsidianWindow } from "../components/ObsidianWindow";
import { useEntrance } from "../components/Animation";
import { theme } from "../data/theme";

export const WorkflowScene = () => {
	const windowStyle = useEntrance(8);
	const caption = useEntrance(28);

	return (
		<AbsoluteFill style={{ padding: "70px 86px" }}>
			<div style={{ ...caption, maxWidth: 760, marginBottom: 30 }}>
				<div style={{ color: "#159A83", fontSize: 30, fontWeight: 900, marginBottom: 12 }}>
					Reusable workflows
				</div>
				<div style={{ fontSize: 56, lineHeight: 1.04, fontWeight: 950 }}>
					Turn repeated note work into one-click actions.
				</div>
			</div>
			<div style={{ ...windowStyle, transform: `${windowStyle.transform} scale(1.03)`, transformOrigin: "top left" }}>
				<ObsidianWindow mode="workflows" />
			</div>
		</AbsoluteFill>
	);
};
