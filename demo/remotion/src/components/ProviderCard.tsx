import { theme } from "../data/theme";

type ProviderCardProps = {
	label: string;
	index: number;
};

const colors = [theme.purple, theme.cyan, theme.green, theme.pink, theme.amber, "#E5E7EB"];

export const ProviderCard = ({ label, index }: ProviderCardProps) => {
	const color = colors[index % colors.length];

	return (
		<div
			style={{
				borderRadius: 16,
				background: "rgba(255, 255, 255, 0.07)",
				border: `1px solid ${theme.border}`,
				padding: 20,
				display: "flex",
				alignItems: "center",
				gap: 14,
				minHeight: 88,
			}}
		>
			<div style={{ width: 18, height: 18, borderRadius: 999, background: color }} />
			<div style={{ fontSize: 23, fontWeight: 900 }}>{label}</div>
		</div>
	);
};
