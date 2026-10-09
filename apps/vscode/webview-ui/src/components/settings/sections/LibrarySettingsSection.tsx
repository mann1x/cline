import {
	DEFAULT_LIBRARY_SETTINGS,
	isCodeIndexWorkspace,
	type LibrarySettings,
	normalizeWorkspaceFolder,
	resolveLibrarySettings,
} from "@cline/shared"
import { parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { embeddingEndpointConfigured, parseRetrievalEndpoints, rerankingEndpointConfigured } from "@shared/retrieval-endpoints"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useMemo } from "react"
import { Slider } from "@/components/ui/slider"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import Section from "../Section"
import { profilesThatMayReadImages, useImageSupport } from "../utils/imageSupport"
import { useRetrievalStatus } from "../utils/useRetrievalStatus"
import { ReaderFileLimit } from "./DocumentReaderOptions"
import LibraryBrowser from "./LibraryBrowser"
import RetrievalEngineStatus from "./RetrievalEngineStatus"

interface LibrarySettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

type NumberKey = {
	[K in keyof LibrarySettings]: LibrarySettings[K] extends number ? K : never
}[keyof LibrarySettings]

/** What the host sent, read through the same normaliser the host uses. */
export function parseLibrarySettings(raw: string | undefined): LibrarySettings {
	try {
		const parsed = JSON.parse(raw || "{}")
		return resolveLibrarySettings(typeof parsed === "object" && parsed !== null ? parsed : {})
	} catch {
		return { ...DEFAULT_LIBRARY_SETTINGS }
	}
}

const hint = "text-xs -mt-2 text-(--vscode-descriptionForeground)"

/**
 * The Library: documents kept for retrieval.
 *
 * This panel says how documents are split and how they are searched. Which
 * model embeds and which reranks is on the Embedding tab of the API
 * configuration, with the other models.
 */
const LibrarySettingsSection = ({ renderSectionHeader }: LibrarySettingsSectionProps) => {
	const {
		libraryEnabled,
		librarySettings,
		embeddingEnabled,
		retrievalEndpoints,
		apiConfigurationProfiles,
		visionModeApiConfiguration,
		extractDocumentMaxFileMb,
	} = useExtensionState()
	const retrieval = useRetrievalStatus()
	const settings = useMemo(() => parseLibrarySettings(librarySettings), [librarySettings])
	const endpoints = useMemo(() => parseRetrievalEndpoints(retrievalEndpoints), [retrievalEndpoints])
	const embedding = embeddingEnabled && embeddingEndpointConfigured(endpoints)
	const reranking = embeddingEnabled && rerankingEndpointConfigured(endpoints)
	const profileNames = useMemo(
		() => parseApiConfigurationProfiles(apiConfigurationProfiles).map((profile) => profile.name),
		[apiConfigurationProfiles],
	)
	// A profile deleted after it was picked is still shown, as gone.
	const imageProfileMissing = settings.imageProfile !== "" && !profileNames.includes(settings.imageProfile)
	// Only profiles whose model may read images are offered: each one's server
	// is asked, and a reported "no" leaves the profile out. The one already
	// picked stays, marked, so a wrong choice is visible instead of blanked.
	const imageSupport = useImageSupport(`${apiConfigurationProfiles ?? ""}\n${visionModeApiConfiguration ?? ""}`)
	const imageProfiles = useMemo(
		() => profilesThatMayReadImages(profileNames, imageSupport, settings.imageProfile),
		[profileNames, imageSupport, settings.imageProfile],
	)
	const hiddenProfiles = profileNames.length - imageProfiles.length
	const describer =
		settings.imageProfile === "" || imageProfileMissing
			? imageSupport?.visionTab
			: imageSupport?.profiles.find((profile) => profile.name === settings.imageProfile)

	const save = useCallback(
		async (patch: Partial<LibrarySettings>) => {
			// The switch is a setting of its own; it is not kept in the record.
			const { enabled: _enabled, ...next } = { ...settings, ...patch }
			try {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ librarySettings: JSON.stringify(next) }))
			} catch (error) {
				console.error("Failed to save the Library settings:", error)
			}
		},
		[settings],
	)

	const number = (key: NumberKey, label: string, text: string) => (
		<>
			<DebouncedTextField
				className="w-full"
				initialValue={String(settings[key])}
				numeric
				onChange={(value) => {
					const parsed = Number(value.trim())
					// An empty or unreadable field goes back to the default.
					void save({ [key]: value.trim() !== "" && Number.isFinite(parsed) ? parsed : DEFAULT_LIBRARY_SETTINGS[key] })
				}}
				placeholder={String(DEFAULT_LIBRARY_SETTINGS[key])}>
				<span className="font-medium">{label}</span>
			</DebouncedTextField>
			<p className={hint}>{text}</p>
		</>
	)

	const unit = settings.splitter === "tokens" ? "tokens" : "characters"

	// The code index is the open folder's, and a choice made per folder.
	const folder = retrieval.status?.workspace.path ?? ""
	const codeIndex = retrieval.status?.codeIndex
	const codeIndexed = folder !== "" && isCodeIndexWorkspace(settings, folder)
	const setCodeIndexed = async (checked: boolean) => {
		if (folder === "") {
			return
		}
		const others = settings.codeIndexWorkspaces.filter(
			(entry) => normalizeWorkspaceFolder(entry) !== normalizeWorkspaceFolder(folder),
		)
		await save({ codeIndexWorkspaces: checked ? [...others, folder] : others })
		// Saved first: the host reads the list to decide whether to build.
		await (checked && embedding ? retrieval.run({ action: "codeIndexRefresh" }) : retrieval.ask({ action: "status" }))
	}
	const codeIndexLine = !codeIndex
		? ""
		: codeIndex.running
			? codeIndex.progress && codeIndex.progress.total > 0
				? `${codeIndex.progress.phase === "reading" ? "Reading" : "Embedding"} file ${codeIndex.progress.done} of ${codeIndex.progress.total}…`
				: "Reading the folder…"
			: codeIndex.files > 0
				? `${codeIndex.files.toLocaleString()} files, ${codeIndex.passages.toLocaleString()} passages.`
				: "Nothing is indexed yet."

	return (
		<div>
			{renderSectionHeader("library")}
			<Section>
				<div>
					<SettingsCheckbox
						checked={libraryEnabled}
						onChange={async (checked) => {
							try {
								await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ libraryEnabled: checked }))
							} catch (error) {
								console.error("Failed to update the Library setting:", error)
								throw error
							}
						}}>
						Enable the Library
					</SettingsCheckbox>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						A place for what you want the model to be able to look things up in: ebooks, manuals, papers, notes and
						web pages, kept as books on shelves, in sections. The model gets <code>search_library</code>, which
						returns the passages that best answer a question, and <code>list_library</code>. Adding and reorganising
						is the librarian's, below. A book keeps its original files, their text and their pictures; the Library is
						in Cerebriline's data folder and is the same in every workspace. It applies from the next task.
					</p>
					{libraryEnabled ? (
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
							{embedding
								? `Searching by keyword and by meaning, embedding with ${endpoints.embedding.model}`
								: "Searching by keyword. Tick “Use an embedding model” in the API configuration to search by meaning as well"}
							{reranking ? `, and reranking with ${endpoints.reranking.model}.` : "."}
						</p>
					) : null}
				</div>

				<div className="pt-3 border-t border-(--vscode-panel-border)">
					<div className="font-medium mb-2">Code search by meaning</div>
					<SettingsCheckbox checked={codeIndexed} onChange={setCodeIndexed}>
						Index the code of this folder
						{retrieval.status?.workspace.name ? ` (${retrieval.status.workspace.name})` : ""}
					</SettingsCheckbox>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						Lets the model find code by describing it: <code>search_codebase</code> gains a <code>semantic</code> mode
						that takes a question in plain words and returns the passages that best match, each with its file and
						lines. For when the model does not know what a thing is called; a regex search and the language server are
						still what it uses when it does. Every source file of the folder is sent to the embedding model set in the
						API configuration, so it is off until ticked, and ticked per folder. Files that <code>.gitignore</code>{" "}
						leaves out are left out, and so are lockfiles, generated files and anything over 256 KB. The index is
						brought up to date when a task starts, and applies from the next task. It does not need the Library to be
						on.
					</p>
					{codeIndexed ? (
						<>
							{embedding ? null : (
								<p className="text-xs mt-1 text-(--vscode-errorForeground)">
									No embedding model is set: tick “Use an embedding model” in the API configuration and name
									one. Until then the model is not offered the mode.
								</p>
							)}
							<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">{codeIndexLine}</p>
							{codeIndex?.problem && !codeIndex.running ? (
								<p className="text-xs mt-1 text-(--vscode-errorForeground)">
									The last run stopped short: {codeIndex.problem}
									{retrieval.status?.lancedb.installed === false
										? " LanceDB holds the vectors; download it here, then update the index."
										: ""}
								</p>
							) : null}
							<div className="flex gap-2 mt-2">
								<VSCodeButton
									appearance="secondary"
									disabled={!embedding || codeIndex?.running === true || retrieval.busy}
									onClick={() => void retrieval.run({ action: "codeIndexRefresh" })}>
									Update now
								</VSCodeButton>
								{retrieval.status?.lancedb.installed === false && !retrieval.status.lancedb.unsupported ? (
									<VSCodeButton
										appearance="secondary"
										disabled={retrieval.status.lancedb.installing || retrieval.busy}
										onClick={() => void retrieval.run({ action: "installVectors" })}>
										{retrieval.status.lancedb.installing ? "Downloading LanceDB…" : "Download LanceDB"}
									</VSCodeButton>
								) : null}
							</div>
						</>
					) : codeIndex && codeIndex.files > 0 ? (
						<div className="mt-2">
							<p className="text-xs mb-2 text-(--vscode-descriptionForeground)">
								An index of {codeIndex.files.toLocaleString()} files is kept from when this was on.
							</p>
							<VSCodeButton
								appearance="secondary"
								disabled={retrieval.busy}
								onClick={() => void retrieval.run({ action: "codeIndexDelete" })}>
								Delete the index
							</VSCodeButton>
						</div>
					) : null}
				</div>

				{libraryEnabled ? (
					<>
						<RetrievalEngineStatus kind="library" retrieval={retrieval} />

						<LibraryBrowser retrieval={retrieval} />

						<div className="pt-3 border-t border-(--vscode-panel-border) font-medium">Pictures</div>
						<SettingsCheckbox
							checked={settings.describeImages}
							onChange={(checked) => void save({ describeImages: checked })}>
							Describe the pictures of a book as it is added
						</SettingsCheckbox>
						<p className={hint}>
							A book's pictures are always taken out and kept with it. Described, a figure can be found by what it
							shows: the description becomes part of the page it is on. Each picture is one request to a vision
							model.
						</p>
						{settings.describeImages ? (
							<>
								<div>
									<label className="font-medium text-sm block mb-1" htmlFor="library-image-profile">
										Profile whose model describes them
									</label>
									<VSCodeDropdown
										className="w-full"
										id="library-image-profile"
										onChange={(event: any) => void save({ imageProfile: String(event.target.value ?? "") })}
										value={settings.imageProfile}>
										<VSCodeOption value="">The Vision tab's model</VSCodeOption>
										{imageProfileMissing ? (
											<VSCodeOption value={settings.imageProfile}>
												{settings.imageProfile} (deleted)
											</VSCodeOption>
										) : null}
										{imageProfiles.map((profile) => (
											<VSCodeOption key={profile.name} value={profile.name}>
												{profile.name}
												{profile.images === "no" ? " (does not read images)" : ""}
											</VSCodeOption>
										))}
									</VSCodeDropdown>
									{describer?.images === "no" ? (
										<p className="text-xs mt-1 text-(--vscode-errorForeground)" role="alert">
											{describer.model} does not read images: its server reports no vision capability, so
											pictures would be kept without a description. Pick another.
										</p>
									) : null}
									{hiddenProfiles > 0 ? (
										<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
											{hiddenProfiles === 1
												? "1 saved profile is left out: its model reports no vision capability."
												: `${hiddenProfiles} saved profiles are left out: their models report no vision capability.`}
										</p>
									) : null}
									<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
										{settings.imageProfile === "" || imageProfileMissing
											? "With no profile picked, the model on the Vision tab of the API configuration is used; with none there either, the model of the conversation is used when its server reports that it reads images. Otherwise pictures are kept without a description."
											: "One of the profiles saved in the API configuration: a cheap, fast model that reads images. Its provider, model, window and sampler are used; the key is the one stored for that provider."}
									</p>
								</div>
								{number(
									"describeImagesLimit",
									"Pictures described per file",
									"The first this many pictures of each file are described; the rest are kept without. Bullets and icons are skipped.",
								)}
							</>
						) : null}

						<div className="pt-3 border-t border-(--vscode-panel-border) font-medium">Reading files</div>
						<ReaderFileLimit id="library-max-file-mb" value={extractDocumentMaxFileMb} />

						<div className="pt-3 border-t border-(--vscode-panel-border) font-medium">Splitting documents</div>
						<p className={hint}>
							A document is cut into passages, and passages are what is searched and returned. These apply to
							documents added from now on; add a document again to split it anew.
						</p>

						<div>
							<label className="font-medium text-sm block mb-1" htmlFor="library-splitter">
								Passage size is measured in
							</label>
							<VSCodeDropdown
								className="w-full"
								id="library-splitter"
								onChange={(event: any) =>
									void save({ splitter: event.target.value === "tokens" ? "tokens" : "characters" })
								}
								value={settings.splitter}>
								<VSCodeOption value="characters">Characters</VSCodeOption>
								<VSCodeOption value="tokens">Tokens (estimated)</VSCodeOption>
							</VSCodeDropdown>
						</div>

						<SettingsCheckbox
							checked={settings.markdownHeaders}
							onChange={(checked) => void save({ markdownHeaders: checked })}>
							Split at headings first
						</SettingsCheckbox>
						<p className={hint}>
							A passage does not run across a heading, and it keeps the headings it sits under, so a result says
							which chapter and section it is from.
						</p>

						{number(
							"chunkSize",
							`Passage size (${unit})`,
							"The most a passage holds. Larger passages carry more context each and find less precisely.",
						)}
						{number(
							"chunkOverlap",
							`Overlap (${unit})`,
							"How much of the end of one passage is repeated at the start of the next, so a sentence cut at the border is whole in one of them. At most half the passage size.",
						)}
						{number(
							"chunkMinSize",
							`Smallest passage (${unit})`,
							"Passages shorter than this are joined to a neighbour under the same heading. 0 leaves them as they are.",
						)}

						<div className="pt-3 border-t border-(--vscode-panel-border) font-medium">Searching</div>

						<SettingsCheckbox
							checked={settings.hybridSearch}
							onChange={(checked) => void save({ hybridSearch: checked })}>
							Hybrid search
						</SettingsCheckbox>
						<p className={hint}>
							With an embedding model, search by keyword and by meaning together and merge the two. Unticked, the
							search is by meaning alone. Keywords find names, codes and exact phrases that meaning misses.
						</p>

						<SettingsCheckbox
							checked={settings.enrichHybridText}
							onChange={(checked) => void save({ enrichHybridText: checked })}>
							Match file names, titles and headings too
						</SettingsCheckbox>
						<p className={hint}>
							A keyword also counts when it is in the document's name or title or in the headings above a passage,
							at half the weight of the text.
						</p>

						<div>
							<div className="flex justify-between text-sm mb-1">
								<span className="font-medium">Balance</span>
								<span className="text-(--vscode-descriptionForeground)">
									{Math.round((1 - settings.bm25Weight) * 100)}% meaning ·{" "}
									{Math.round(settings.bm25Weight * 100)}% keywords
								</span>
							</div>
							<Slider
								aria-label="Balance between meaning and keywords"
								disabled={!settings.hybridSearch}
								max={100}
								min={0}
								onValueChange={([next]) => void save({ bm25Weight: next / 100 })}
								step={5}
								value={[Math.round(settings.bm25Weight * 100)]}
							/>
							<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
								How much each ranking counts when the two are merged, from meaning alone on the left to keywords
								alone on the right.
							</p>
						</div>

						{number(
							"topK",
							"Passages kept from the search",
							"How many of the best passages go on: to the reranker when there is one, to the model otherwise.",
						)}
						{number("topKReranker", "Passages kept after reranking", "How many the reranker hands to the model.")}
						<div>
							<div className="flex justify-between text-sm mb-1">
								<span className="font-medium">Relevance threshold</span>
								<span className="text-(--vscode-descriptionForeground)">
									{settings.relevanceThreshold.toFixed(2)}
								</span>
							</div>
							<Slider
								aria-label="Relevance threshold"
								max={100}
								min={0}
								onValueChange={([next]) => void save({ relevanceThreshold: next / 100 })}
								step={5}
								value={[Math.round(settings.relevanceThreshold * 100)]}
							/>
							<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
								Passages the reranker scores below this are dropped, so a question the Library cannot answer
								returns little or nothing instead of the least bad passages. 0 keeps them all. Without a reranker
								it applies only to a search by meaning alone.
							</p>
						</div>

						<div className="pt-3 border-t border-(--vscode-panel-border) font-medium">
							Embedding and reranking requests
						</div>
						{number(
							"embeddingBatchSize",
							"Passages per embedding request",
							"More per request is faster on a server that batches, until a request is larger than the server takes.",
						)}
						{number(
							"embeddingConcurrency",
							"Embedding requests at once",
							"0 sends them all at once and leaves the queueing to the server.",
						)}
						{number("rerankingBatchSize", "Passages per reranking request", "")}

						<DebouncedTextField
							className="w-full"
							initialValue={settings.embeddingQueryPrefix}
							onChange={(value) => void save({ embeddingQueryPrefix: value })}
							placeholder="None">
							<span className="font-medium">Prefix for questions</span>
						</DebouncedTextField>
						<DebouncedTextField
							className="w-full"
							initialValue={settings.embeddingDocumentPrefix}
							onChange={(value) => void save({ embeddingDocumentPrefix: value })}
							placeholder="None">
							<span className="font-medium">Prefix for passages</span>
						</DebouncedTextField>
						<p className={hint}>
							Some embedding models were trained with an instruction in front of the text, different for a question
							and for a passage (<code>query: </code> and <code>passage: </code> for the E5 family,{" "}
							<code>search_query: </code> and <code>search_document: </code> for nomic-embed-text). Leave both empty
							unless the model's card asks for them. Changing the passage prefix does not re-embed what is already
							in.
						</p>
					</>
				) : null}
			</Section>
		</div>
	)
}

export default LibrarySettingsSection
