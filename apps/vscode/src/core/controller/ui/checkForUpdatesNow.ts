import { checkForUpdatesNow as runCheck } from "@services/updates/update-service"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Check for a newer release now. The About tab's button.
 *
 * Not awaited: the check ends in a notification that stays up until it is
 * answered, and the button should come back as soon as the question has been
 * asked rather than when the user has dealt with the answer.
 */
export async function checkForUpdatesNow(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	void runCheck().catch((error) => {
		Logger.error(`Failed to check for updates: ${error}`)
	})
	return Empty.create({})
}
