import { theme } from "../data/theme";

type ComposerProps = {
	value: string;
};

export const Composer = ({ value }: ComposerProps) => {
	return (
		<div
			style={{
				borderRadius: 16,
				border: `1px solid ${theme.border}`,
				background: "rgba(9, 13, 26, 0.76)",
				padding: 14,
			}}
		>
			<div style={{ fontSize: 14, color: theme.weak, fontWeight: 800, marginBottom: 10 }}>
				Output: Chat
			</div>
			<div
				style={{
					minHeight: 86,
					color: theme.text,
					fontSize: 18,
					lineHeight: 1.35,
				}}
			>
				{value}
				<span style={{ color: theme.cyan }}>|</span>
			</div>
			<div
				style={{
					marginTop: 12,
					height: 38,
					borderRadius: 10,
					background: `linear-gradient(135deg, ${theme.purple}, ${theme.cyan})`,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontWeight: 900,
					color: "#06111E",
				}}
			>
				Send
			</div>
		</div>
	);
};
