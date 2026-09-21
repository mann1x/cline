import type { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"

/**
 * The Cerebriline mark, themed to VS Code and to the environment.
 *
 * Same geometry as the activity-bar icon (`apps/vscode/assets/icons/icon.svg`),
 * which is the brand mark (`icon.png`) reduced to what survives at 24px: the
 * head with its side vents, the antenna, the brain under the dome, and the two
 * eyes. Drawn as strokes rather than fills, because that reduction is a line
 * glyph -- so the environment colour goes on `stroke`, where `ClineLogoVariable`
 * puts it on `fill`.
 *
 * Keeping one geometry for the activity bar and the panel is the point: the
 * thing in the sidebar and the thing at the top of a new session are the same
 * mark at two sizes, not two drawings that have to be kept in step.
 */
const CerebrilineLogo = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, ...svgProps } = props
	const strokeColor = environment ? getEnvironmentColor(environment) : "var(--vscode-icon-foreground)"

	return (
		<svg fill="none" height="24" role="img" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" {...svgProps}>
			<title>Cerebriline</title>
			<g stroke={strokeColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
				{/* antenna */}
				<circle cx="12" cy="1.9" r="1" />
				<path d="M12 2.9v1.5" />
				{/* head, and the vents either side of it */}
				<rect height="15.2" rx="4.2" width="15.2" x="4.4" y="4.4" />
				<path d="M4.4 10.6H3.2A1.2 1.2 0 0 0 2 11.8v1.8a1.2 1.2 0 0 0 1.2 1.2h1.2" />
				<path d="M19.6 10.6h1.2A1.2 1.2 0 0 1 22 11.8v1.8a1.2 1.2 0 0 1-1.2 1.2h-1.2" />
				{/* the brain under the dome */}
				<path d="M7.9 10.3c-1.1-.8-.8-2.6.6-3 .2-1.4 1.9-2 2.9-1" />
				<path d="M16.1 10.3c1.1-.8.8-2.6-.6-3-.2-1.4-1.9-2-2.9-1" />
				<path d="M12 6.3v4" />
				<path d="M7.4 10.3h9.2" />
				{/* eyes */}
				<rect height="4.6" rx="1.3" width="2.6" x="8.3" y="13" />
				<rect height="4.6" rx="1.3" width="2.6" x="13.1" y="13" />
			</g>
		</svg>
	)
}

export default CerebrilineLogo
