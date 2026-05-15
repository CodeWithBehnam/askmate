import { theme } from "../data/theme";

type NoteEditorProps = {
	note: {
		title: string;
		path: string;
		lines: string[];
	};
	highlightSelection?: boolean;
};

export const NoteEditor = ({ note, highlightSelection = false }: NoteEditorProps) => {
	return (
		<div style={{ padding: "28px 34px", background: "#F8F9FB", color: theme.text }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
				<div style={{ width: 34, height: 34, borderRadius: 999, background: "#DFE5EF", display: "grid", placeItems: "center", color: "#717782", fontWeight: 900 }}>
					●
				</div>
				<div style={{ color: "#717782", fontSize: 20 }}>hi</div>
				<div style={{ marginLeft: "auto", width: 34, height: 34, borderRadius: 999, border: "1px solid #D8DCE3", display: "grid", placeItems: "center", color: "#727984" }}>
					✎
				</div>
			</div>
			<div
				style={{
					background: "#FFFFFF",
					border: "1px solid #E0E3E8",
					borderRadius: 12,
					padding: "18px 20px",
					boxShadow: "0 12px 30px rgba(31, 41, 55, 0.06)",
					display: "flex",
					alignItems: "center",
					gap: 12,
					marginBottom: 22,
				}}
			>
				<div style={{ width: 34, height: 34, borderRadius: 999, background: "#E5EEFF", display: "grid", placeItems: "center", color: theme.blue, fontWeight: 950 }}>
					✦
				</div>
				<div style={{ color: "#5F6670", fontSize: 19 }}>Hi! How can I help with your PLife vault today?</div>
				<div style={{ marginLeft: "auto", display: "flex", gap: 8, color: "#8B929C" }}>
					{["▣", "↩", "⌂", "⊞", "✎", "H1"].map((icon) => (
						<div key={icon} style={{ width: 32, height: 32, borderRadius: 999, border: "1px solid #E1E4EA", display: "grid", placeItems: "center", background: "#FAFBFC", fontSize: 14 }}>
							{icon}
						</div>
					))}
				</div>
			</div>
			<div
				style={{
					background: "#FFFFFF",
					border: "1px solid #E3E5EA",
					borderRadius: 10,
					padding: 28,
					height: 478,
					fontSize: 22,
					lineHeight: 1.54,
					color: "#3C424B",
					overflow: "hidden",
				}}
			>
				<div style={{ color: theme.weak, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
					{note.path}
				</div>
				<div style={{ fontSize: 36, fontWeight: 850, marginBottom: 18 }}>{note.title}</div>
				{note.lines.map((line, index) => {
					const selected = highlightSelection && index === note.lines.length - 1;
					return (
						<div
							key={`${line}-${index}`}
							style={{
								minHeight: 34,
								padding: selected ? "5px 9px" : "0 0",
								borderRadius: selected ? 8 : 0,
								background: selected ? "rgba(119, 169, 242, 0.24)" : "transparent",
								color: index === 0 ? "#2E333B" : "#3C424B",
								fontWeight: index === 0 ? 850 : 500,
							}}
						>
							{line}
						</div>
					);
				})}
			</div>
		</div>
	);
};
