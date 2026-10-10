import type { RetrievalEndpointCheck } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import { useRetrievalStatus } from "../utils/useRetrievalStatus"

const muted = "text-xs text-(--vscode-descriptionForeground)"

/**
 * Web scraping: the Firecrawl endpoint pages are read through, who may use
 * it, and how far one crawl may go. Setting it up here is half of it; the
 * other half is the tick in the API configuration that allows a session to
 * use it.
 */
const ScrapeSettings = () => {
	const { status, busy, run } = useRetrievalStatus()
	const [check, setCheck] = useState<RetrievalEndpointCheck>()
	if (!status) {
		return null
	}
	const { scrape } = status
	const limit = (key: "maxPages" | "maxDepth", label: string, fallback: number) => (
		<DebouncedTextField
			className="w-full"
			initialValue={String(scrape[key])}
			numeric
			onChange={(value) => {
				const parsed = Number(value.trim())
				void run({ action: "setScrape", [key]: value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback })
			}}
			placeholder={String(fallback)}>
			<span className="font-medium">{label}</span>
		</DebouncedTextField>
	)
	return (
		<div className="py-3 border-t border-editor-widget-border/50" id="web-scraping">
			<SettingsCheckbox
				checked={scrape.enabled}
				onChange={async (checked) => {
					await run({ action: "setScrape", enabled: checked })
				}}>
				Web scraping
			</SettingsCheckbox>
			<p className={`mt-1 ${muted}`}>
				Lets the model search the web, read pages and crawl a site through a{" "}
				<a href="https://github.com/firecrawl/firecrawl">Firecrawl</a> endpoint. The tools reach a task only when “Allow
				web scraping” is ticked in the API configuration; otherwise they are never offered.
			</p>
			{scrape.enabled ? (
				<div className="flex flex-col gap-2 mt-2">
					<div>
						<SettingsCheckbox
							checked={scrape.librarianOnly}
							onChange={async (checked) => {
								await run({ action: "setScrape", librarianOnly: checked })
							}}>
							Only for the librarian
						</SettingsCheckbox>
						<p className={`mt-1 ${muted}`}>
							{scrape.librarianOnly
								? "Scraping is used only by the librarian (Settings > Library), to make a book from web pages and to check it for news later."
								: "Every task is offered a web_scrape tool: search, list a site's pages, read a page, and crawl a site into markdown files in the workspace. The librarian uses it too."}{" "}
							Takes effect in the next task.
						</p>
					</div>
					<DebouncedTextField
						className="w-full"
						initialValue={scrape.baseUrl}
						onChange={(value) => void run({ action: "setScrape", baseUrl: value.trim() })}
						placeholder="http://192.168.178.2:3002">
						<span className="font-medium">Firecrawl endpoint</span>
					</DebouncedTextField>
					<DebouncedTextField
						className="w-full"
						initialValue=""
						onChange={(value) => void run({ action: "setScrape", apiKey: value })}
						placeholder={
							scrape.keySet ? "Stored — type to replace, clear to remove" : "Leave empty if the endpoint needs none"
						}
						type="password">
						<span className="font-medium">API key</span>
					</DebouncedTextField>
					{limit("maxPages", "Pages one crawl or book may read in a call", 100)}
					{limit("maxDepth", "Links deep a crawl may follow", 3)}
					<p className={muted}>
						The model asks for a depth and a page count per crawl or book; these are the most it gets. A crawl reads
						pages from the open web on your behalf, from the machine the endpoint runs on.
					</p>
					<div className="flex items-center gap-2">
						<VSCodeButton
							appearance="secondary"
							disabled={busy || !scrape.baseUrl}
							onClick={async () => {
								setCheck(undefined)
								setCheck((await run({ action: "checkScrape" }))?.check)
							}}>
							Check
						</VSCodeButton>
						{check ? (
							<span className={check.ok ? muted : "text-xs text-(--vscode-errorForeground)"}>{check.detail}</span>
						) : null}
					</div>
					{scrape.problem ? <p className="text-xs text-(--vscode-errorForeground)">{scrape.problem}</p> : null}
				</div>
			) : null}
		</div>
	)
}

export default ScrapeSettings
