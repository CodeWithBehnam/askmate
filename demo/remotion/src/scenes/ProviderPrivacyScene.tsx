import { AbsoluteFill } from "remotion";
import { ProviderCard } from "../components/ProviderCard";
import { useEntrance } from "../components/Animation";
import { privacyPoints, providers } from "../data/script";
import { theme } from "../data/theme";

export const ProviderPrivacyScene = () => {
	const left = useEntrance(8);
	const right = useEntrance(26);

	return (
		<AbsoluteFill style={{ padding: 86 }}>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 0.86fr", gap: 58, height: "100%", alignItems: "center" }}>
				<div style={left}>
					<div style={{ color: theme.pink, fontSize: 30, fontWeight: 900, marginBottom: 14 }}>
						Provider choice
					</div>
					<div style={{ fontSize: 64, lineHeight: 1.02, fontWeight: 950, marginBottom: 34 }}>
						Use the model stack that fits each vault.
					</div>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
						{providers.map((provider, index) => (
							<ProviderCard key={provider} label={provider} index={index} />
						))}
					</div>
				</div>
				<div
					style={{
						...right,
						borderRadius: 24,
						border: `1px solid ${theme.border}`,
						background: "rgba(255, 255, 255, 0.07)",
						padding: 34,
					}}
				>
					<div style={{ color: theme.cyan, fontSize: 28, fontWeight: 950, marginBottom: 24 }}>
						Privacy-first defaults
					</div>
					{privacyPoints.map((point) => (
						<div
							key={point}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 16,
								fontSize: 28,
								fontWeight: 850,
								marginBottom: 20,
								color: "#EAF7FF",
							}}
						>
							<div style={{ width: 18, height: 18, borderRadius: 999, background: theme.green }} />
							{point}
						</div>
					))}
				</div>
			</div>
		</AbsoluteFill>
	);
};
