import { type EventMessage, PostHog } from "posthog-node"
import { ClineEndpoint } from "@/config"
import { fetch } from "@/shared/net"
import { posthogConfig } from "@/shared/services/config/posthog-config"
import { Logger } from "@/shared/services/Logger"

import { name as EXTENSION_NAME, publisher as EXTENSION_PUBLISHER } from "../../../../../package.json"

/** Lower-case fragments that identify a stack frame as ours. */
const OWN_FILE_MARKERS = [EXTENSION_PUBLISHER.toLowerCase(), EXTENSION_NAME.toLowerCase(), "cline"]

export class PostHogClientProvider {
	private static _instance: PostHogClientProvider | null = null

	public static getInstance(): PostHogClientProvider {
		if (!PostHogClientProvider._instance) {
			PostHogClientProvider._instance = new PostHogClientProvider()
		}
		return PostHogClientProvider._instance
	}

	public static getClient(): PostHog | null {
		return PostHogClientProvider.getInstance().client
	}

	private readonly client: PostHog | null

	private constructor() {
		// Skip PostHog client initialization in self-hosted mode
		if (ClineEndpoint.isSelfHosted()) {
			this.client = null
			return
		}

		// Initialize PostHog client
		this.client = posthogConfig.apiKey
			? new PostHog(posthogConfig.apiKey, {
					host: posthogConfig.host,
					fetch: (url, options) => fetch(url, options),
					enableExceptionAutocapture: false, // This is only enabled for error services
					before_send: (event) => PostHogClientProvider.eventFilter(event),
				})
			: null

		if (this.client) {
			Logger.log("PostHog client initialized")
		}
	}

	/**
	 * Filters PostHog events before they are sent.
	 * For exceptions, we only capture those from the Cline extension.
	 * this is specifically to avoid capturing errors from anything other than Cline
	 */
	static eventFilter(event: EventMessage | null) {
		if (!event || event?.event !== "$exception") {
			return event
		}
		const exceptionList = event.properties?.["$exception_list"]
		if (!exceptionList?.length) {
			return null
		}

		// Check if any exception is from Cline
		for (let i = 0; i < exceptionList.length; i++) {
			const stacktrace = exceptionList[i].stacktrace
			// Fast check: the error message names us
			if (OWN_FILE_MARKERS.some((marker) => stacktrace?.value?.toLowerCase().includes(marker))) {
				return event
			}

			const frames = stacktrace?.frames
			if (frames?.length) {
				for (let j = 0; j < frames.length; j++) {
					const fileName = frames[j]?.filename
					// The extension's files sit under `<publisher>.<name>-<version>`,
					// and the CLI's under "cline". Both halves of the extension id
					// are matched because neither is a substring of the other, and
					// hard-coding either one is how this check quietly stopped
					// recognising its own errors when the extension was renamed.
					if (OWN_FILE_MARKERS.some((marker) => fileName?.includes(marker))) {
						return event
					}
				}
			}
		}

		return null
	}

	public async dispose(): Promise<void> {
		await this.client?.shutdown().catch((error) => Logger.error("Error shutting down PostHog client:", error))
	}
}
