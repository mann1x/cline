import { installOcrLanguages } from "@cline/core"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

/**
 * Download the Document Reader's OCR languages the user just added.
 *
 * Run when the setting changes rather than at the first scanned page: the
 * user is looking at the setting and can see a failure, and a session should
 * never fetch anything mid-task that nobody asked for. English ships with the
 * extension and is never downloaded; languages already installed are skipped.
 */
export async function installDocumentReaderLanguages(languages: readonly string[]): Promise<void> {
	const wanted = languages.filter((code) => code !== "eng")
	if (wanted.length === 0) {
		return
	}
	try {
		const result = await installOcrLanguages(wanted)
		if (result.installed.length > 0) {
			Logger.log(`[Documents] Installed OCR language(s): ${result.installed.join(", ")}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Document Reader: installed OCR language${result.installed.length === 1 ? "" : "s"} ${result.installed.join(", ")}.`,
			})
		}
		if (result.failed.length > 0) {
			const reasons = result.failed.map((failure) => `${failure.language} (${failure.reason})`).join(", ")
			Logger.warn(`[Documents] OCR language(s) not installed: ${reasons}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Document Reader: could not install ${reasons}. Scanned pages in ${result.failed.length === 1 ? "that language" : "those languages"} will not be recognized until it is installed; remove it and add it again to retry.`,
			})
		}
	} catch (error) {
		Logger.warn(`[Documents] OCR language install failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}
