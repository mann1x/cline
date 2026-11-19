import { Empty } from "@shared/proto/cline/common"
import { PromptTemplateToggleRequest } from "@shared/proto/cline/file"
import { setPromptTemplateEnabled as setEnabled } from "@/sdk/prompt-template-settings"
import { Controller } from ".."

/**
 * Switches a prompt template on or off by name.
 *
 * Written to core's global settings, which the CLI and SDK hosts read too, so
 * a template switched off here is off for every session in every host. Takes
 * effect from the next session; a running one keeps the template it started
 * with, since a session resolves its template once.
 */
export async function setPromptTemplateEnabled(_controller: Controller, request: PromptTemplateToggleRequest): Promise<Empty> {
	setEnabled(request.name, request.enabled)
	return Empty.create({})
}
