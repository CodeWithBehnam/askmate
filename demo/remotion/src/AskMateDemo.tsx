import { AbsoluteFill, Series } from "remotion";
import { IntroScene } from "./scenes/IntroScene";
import { AskScene } from "./scenes/AskScene";
import { WorkflowScene } from "./scenes/WorkflowScene";
import { SafeApplyScene } from "./scenes/SafeApplyScene";
import { ProviderPrivacyScene } from "./scenes/ProviderPrivacyScene";
import { OutroScene } from "./scenes/OutroScene";
import { fontFamily, theme } from "./data/theme";

export const AskMateDemo = () => {
	return (
		<AbsoluteFill
			style={{
				background:
					"linear-gradient(135deg, #F7F8FA 0%, #E8ECF4 52%, #F4F6F9 100%)",
				color: theme.text,
				fontFamily,
			}}
		>
			<Series>
				<Series.Sequence durationInFrames={180}>
					<IntroScene />
				</Series.Sequence>
				<Series.Sequence durationInFrames={420}>
					<AskScene />
				</Series.Sequence>
				<Series.Sequence durationInFrames={390}>
					<WorkflowScene />
				</Series.Sequence>
				<Series.Sequence durationInFrames={480}>
					<SafeApplyScene />
				</Series.Sequence>
				<Series.Sequence durationInFrames={420}>
					<ProviderPrivacyScene />
				</Series.Sequence>
				<Series.Sequence durationInFrames={360}>
					<OutroScene />
				</Series.Sequence>
			</Series>
		</AbsoluteFill>
	);
};
