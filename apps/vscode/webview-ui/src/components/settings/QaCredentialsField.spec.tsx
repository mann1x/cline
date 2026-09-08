import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import QaCredentialsField from "./QaCredentialsField"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({
	value: { qaCredentialNames: [] as string[] },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("./utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

function fieldFor(label: string): HTMLInputElement {
	const field = screen.getByText(label).closest("vscode-text-field")
	if (!field) {
		throw new Error(`no field labelled ${label}`)
	}
	return field as unknown as HTMLInputElement
}

function type(label: string, value: string): void {
	const field = fieldFor(label)
	field.value = value
	fireEvent(field, new Event("input", { bubbles: true }))
}

describe("QA credentials", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = { qaCredentialNames: [] }
	})

	it("lists the names it was given", () => {
		mockExtensionState.value = { qaCredentialNames: ["QA_USER", "QA_PASSWORD"] }

		render(<QaCredentialsField />)

		expect(screen.getByText("QA_USER")).toBeTruthy()
		expect(screen.getByText("QA_PASSWORD")).toBeTruthy()
	})

	it("sends the new credential as a delta, leaving the others alone", () => {
		mockExtensionState.value = { qaCredentialNames: ["QA_USER"] }
		render(<QaCredentialsField />)

		type("Name", "QA_PASSWORD")
		type("Value", "long-enough-value")
		fireEvent.click(screen.getByText("Add"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("qaCredentials", {
			set: [{ name: "QA_PASSWORD", value: "long-enough-value" }],
			remove: [],
		})
	})

	it("removes by name only, never sending a value", () => {
		mockExtensionState.value = { qaCredentialNames: ["QA_USER"] }
		render(<QaCredentialsField />)

		fireEvent.click(screen.getByText("Remove"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("qaCredentials", {
			set: [],
			remove: ["QA_USER"],
		})
	})

	// The store refuses a value it cannot mask out of command output, so saying
	// so here beats letting the user believe a credential is configured.
	it("refuses a value too short to be masked", () => {
		render(<QaCredentialsField />)

		type("Name", "QA_PIN")
		type("Value", "1234")

		expect(screen.getByText(/cannot be masked/)).toBeTruthy()
		expect((screen.getByText("Add").closest("vscode-button") as HTMLButtonElement).disabled).toBe(true)
	})

	it("refuses a name that is not an environment variable", () => {
		render(<QaCredentialsField />)

		type("Name", "2FA_CODE")
		type("Value", "long-enough-value")

		expect(screen.getByText(/environment variable/)).toBeTruthy()
	})

	// A write-only store has no edit-in-place: entering the same name again is
	// the only way to change a value, and the button should say so.
	it("offers to replace a name that is already set", () => {
		mockExtensionState.value = { qaCredentialNames: ["QA_USER"] }
		render(<QaCredentialsField />)

		type("Name", "QA_USER")
		type("Value", "a-new-long-value")

		expect(screen.getByText("Replace")).toBeTruthy()
	})
})
