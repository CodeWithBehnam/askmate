import { theme } from "../data/theme";

type DiffPreviewProps = {
	rows: Array<{
		kind: string;
		text: string;
	}>;
};

export const DiffPreview = ({ rows }: DiffPreviewProps) => {
	return (
		<div
			style={{
				borderRadius: 16,
				background: "rgba(255, 255, 255, 0.07)",
				border: `1px solid ${theme.border}`,
				padding: 16,
			}}
		>
			<div style={{ color: theme.amber, fontSize: 14, fontWeight: 900, marginBottom: 10 }}>
				SAFE APPLY PREVIEW
			</div>
			<div style={{ fontSize: 21, fontWeight: 900, marginBottom: 14 }}>Review before writing</div>
			{rows.map((row) => {
				const added = row.kind === "added";
				return (
					<div
						key={row.text}
						style={{
							background: added ? "rgba(52, 211, 153, 0.14)" : "rgba(248, 113, 113, 0.14)",
							border: `1px solid ${added ? "rgba(52, 211, 153, 0.35)" : "rgba(248, 113, 113, 0.35)"}`,
							color: added ? "#D9FFF0" : "#FFE1E1",
							borderRadius: 10,
							padding: 10,
							fontSize: 14,
							lineHeight: 1.3,
							marginBottom: 10,
						}}
					>
						{added ? "+ " : "- "}
						{row.text}
					</div>
				);
			})}
			<div
				style={{
					marginTop: 14,
					height: 38,
					borderRadius: 10,
					background: theme.green,
					color: "#062318",
					fontWeight: 950,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				Apply change
			</div>
		</div>
	);
};
