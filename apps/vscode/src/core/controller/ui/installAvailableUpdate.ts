import { installAvailableUpdate as runInstall } from "@services/updates/update-service"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Install the release the home-page banner is advertising.
 *
 * The banner exists because a toast is gone the moment it is dismissed, and
 * someone who was away from the keyboard when the check ran would otherwise
 * never learn there is a newer build. Its button does exactly what the toast's
 * did — download, verify against the hash published with the release, install,
 * offer to reload — so there is one implementation and not two.
 */
export async function installAvailableUpdate(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		await runInstall()
	} catch (error) {
		// Reported to the user by the service itself; this only keeps a failed
		// install from surfacing in the webview as a broken button.
		Logger.error(`Failed to install the available update: ${error}`)
	}
	return Empty.create({})
}
