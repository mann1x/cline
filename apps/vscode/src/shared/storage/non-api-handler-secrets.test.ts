import { describe, expect, it } from "vitest"
import { NonApiHandlerSecretKeys, SecretKeys } from "./state-keys"

/**
 * The API configuration is `ApiHandlerOptionSettings & Secrets`, and it is sent
 * to the webview inside `state_json`. That is fine for a provider key, which
 * the settings view exists to show; it is not fine for a QA credential, whose
 * whole design is that the value never leaves the extension host.
 *
 * So a secret stored for some other purpose has to be named here, and this
 * exists because nothing else would notice if it stopped being.
 */
describe("secrets that must not ride into the API configuration", () => {
	it("keeps QA credentials out", () => {
		expect(NonApiHandlerSecretKeys.has("qaCredentials")).toBe(true)
	})

	it("names only keys that are actually stored", () => {
		for (const key of NonApiHandlerSecretKeys) {
			expect(SecretKeys).toContain(key)
		}
	})

	// Provider credentials belong in the API configuration — that is what it is
	// for. Excluding one would break the settings view rather than protect
	// anything.
	it("does not exclude a provider credential", () => {
		expect(NonApiHandlerSecretKeys.has("apiKey")).toBe(false)
		expect(NonApiHandlerSecretKeys.has("openRouterApiKey")).toBe(false)
	})
})
