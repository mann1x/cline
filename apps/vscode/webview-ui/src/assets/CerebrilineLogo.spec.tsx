import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import CerebrilineLogo from "./CerebrilineLogo"

const SRC = join(__dirname, "..")

// Every view that shows the product mark. HomeHeader was done in 4.100.152;
// these three were the remainder, and AccountWelcomeView is the one that
// appears in normal use rather than only on first run.
const MARKED_VIEWS = [
	"components/welcome/HomeHeader.tsx",
	"components/welcome/WelcomeView.tsx",
	"components/onboarding/OnboardingView.tsx",
	"components/account/AccountWelcomeView.tsx",
]

describe("the product mark", () => {
	it("renders a titled Cerebriline glyph", () => {
		const { container } = render(<CerebrilineLogo />)
		expect(container.querySelector("title")?.textContent).toBe("Cerebriline")
	})

	// A de-branding requirement is about which glyph a view draws, so that is
	// what this asserts. Rendering all four costs their whole provider trees
	// and would still only prove the import.
	it.each(MARKED_VIEWS)("%s draws the Cerebriline mark and no Cline mark", (relative) => {
		// AccountWelcomeView carries an incomplete commented-out copy of an
		// older version of itself, upstream's, which still names ClineLogoWhite
		// in what looks like real JSX. Strip comments so the assertion is about
		// what the view draws rather than about what a comment mentions.
		const source = readFileSync(join(SRC, relative), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")

		expect(source).toContain("CerebrilineLogo")
		expect(source).not.toMatch(/<ClineLogo(White|Variable|Santa)\b/)
	})
})
