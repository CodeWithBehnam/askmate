import { demoNote } from "../data/script";
import { theme } from "../data/theme";
import { AskMateSidebar, SidebarMode } from "./AskMateSidebar";
import { NoteEditor } from "./NoteEditor";

type ObsidianWindowProps = {
	mode: SidebarMode;
	highlightSelection?: boolean;
};

export const ObsidianWindow = ({ mode, highlightSelection = false }: ObsidianWindowProps) => {
	return (
		<div
			style={{
				width: 1240,
				height: 820,
				borderRadius: 14,
				background: "#ECEFF4",
				border: "1px solid #D5D8DE",
				boxShadow: "0 28px 80px rgba(31, 41, 55, 0.18)",
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 430px", minHeight: 0 }}>
				<NoteEditor note={demoNote} highlightSelection={highlightSelection} />
				<AskMateSidebar mode={mode} />
			</div>
		</div>
	);
};
