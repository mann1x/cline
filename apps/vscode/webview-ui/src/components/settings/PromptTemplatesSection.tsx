import { EmptyRequest } from "@shared/proto/cline/common"
import {
	PromptTemplateEditRequest,
	type PromptTemplateInfo,
	type PromptTemplates,
	PromptTemplateToggleRequest,
} from "@shared/proto/cline/file"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle, CircleAlert, FilePenLine, RefreshCw, Sparkles, Trash2 } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileServiceClient } from "@/services/grpc-client"
import { useUserCheckboxChange } from "./common/useUserCheckboxChange"

/**
 * The prompt templates panel.
 *
 * The question this answers is "which prompt is my model actually running on",
 * which until now had no answer anywhere in the UI. Templates resolve from
 * three directories by provider, model family and model name, and a template
 * can lose to a more specific one or be shadowed outright by a namesake in a
 * nearer directory — none of which is guessable from the file. So the list is
 * shown resolved: the winner is marked, losers say what they would have
 * matched, and anything that failed to parse says why.
 */

function sourceLabel(source: string): string {
	if (source === "builtin") {
		return "Built-in"
	}
	return source === "global" ? "Global" : "Workspace"
}

/** The base layer: every other template is a diff on it, so it is always on. */
const DEFAULT_TEMPLATE_NAME = "default"

/** At most this many names before the gap is reported as a count. */
const MAX_NAMED_GAPS = 4

/**
 * Say what a template does *not* cover, rather than what it does.
 *
 * Every shipped template covers all thirty-one tools, so listing them printed
 * the same paragraph under every row and buried the two things a reader is
 * actually looking for: which template is active, and whether it has a hole in
 * it. A gap is the exception and the only part worth the width — a tool with no
 * section silently keeps its built-in description.
 */
function describeCoverage(covered: readonly string[], everyTool: readonly string[]): string {
	if (everyTool.length === 0) {
		// No `default` row to measure against, so a count is all that can be
		// said honestly.
		if (covered.length === 0) {
			return "no tool overrides"
		}
		return covered.length === 1 ? "1 tool" : `${covered.length} tools`
	}
	const missing = everyTool.filter((tool) => !covered.includes(tool))
	if (missing.length === 0) {
		return `all ${everyTool.length} tools`
	}
	if (missing.length === everyTool.length) {
		return "no tool overrides"
	}
	const named = missing.slice(0, MAX_NAMED_GAPS).join(", ")
	const rest = missing.length - MAX_NAMED_GAPS
	return `missing ${rest > 0 ? `${named} and ${rest} more` : named}`
}

const TemplateRow = memo(
	({
		template,
		everyTool,
		onEdit,
		onDelete,
		onToggle,
		replacesBuiltin,
	}: {
		template: PromptTemplateInfo
		/** Every tool a session can be handed, for reporting what is not covered. */
		everyTool: readonly string[]
		onEdit: (template: PromptTemplateInfo) => void
		onDelete: (template: PromptTemplateInfo) => Promise<void>
		/** Switches the template on or off by name, the builtin and its copies together. */
		onToggle: (template: PromptTemplateInfo, enabled: boolean) => Promise<void>
		/** A builtin of the same name exists, so deleting this file hands the name back to it. */
		replacesBuiltin: boolean
	}) => {
		const dimmed = template.shadowed || template.disabled || template.error !== undefined
		// `default` is what every other template falls back to; switching it off
		// would leave nothing to fall to. A file that did not parse has no name a
		// session could match, so there is nothing to switch.
		const switchable = template.name.trim().toLowerCase() !== DEFAULT_TEMPLATE_NAME && template.error === undefined
		const enabled = !template.disabled
		// The toolkit checkbox fires `change` when a re-render moves it too; only
		// a click that differs from what is shown is the user's (ol-54).
		const onEnabledChange = useUserCheckboxChange(enabled, (checked) => void onToggle(template, checked))
		// A builtin is in the bundle, not on disk: there is nothing to delete.
		const deletable = template.source !== "builtin" && template.filePath !== undefined
		const [confirming, setConfirming] = useState(false)
		const [deleting, setDeleting] = useState(false)

		const remove = async () => {
			setDeleting(true)
			try {
				await onDelete(template)
			} finally {
				setDeleting(false)
				setConfirming(false)
			}
		}

		return (
			<div
				className={`flex flex-col gap-1 py-2 border-b border-editor-widget-border/40 last:border-b-0 ${
					dimmed ? "opacity-60" : ""
				}`}>
				<div className="flex items-center gap-2 flex-wrap">
					<span className="text-sm font-medium text-foreground">{template.name}</span>
					<Badge variant={template.source === "builtin" ? "outline" : "info"}>{sourceLabel(template.source)}</Badge>
					{template.active && <Badge variant="success">Active</Badge>}
					{template.shadowed && <Badge variant="outline">Shadowed</Badge>}
					{template.disabled && <Badge variant="outline">Off</Badge>}
					{template.error !== undefined && <Badge variant="danger">Not loaded</Badge>}
					{switchable && (
						<VSCodeCheckbox
							aria-label={`Use ${template.name}`}
							checked={enabled}
							className="ml-auto text-xs"
							data-testid={`use-template-${template.name}`}
							onChange={onEnabledChange}
							title={
								enabled
									? `Switch ${template.name} off: the models it claims fall back to default`
									: `Switch ${template.name} back on`
							}>
							On
						</VSCodeCheckbox>
					)}
					<Button
						aria-label={`Edit ${template.fileName}`}
						className={switchable ? undefined : "ml-auto"}
						onClick={() => onEdit(template)}
						size="xs"
						variant="ghost">
						<FilePenLine />
						Edit
					</Button>
					{deletable && (
						<Button
							aria-label={`Delete ${template.fileName}`}
							disabled={confirming || deleting}
							onClick={() => setConfirming(true)}
							size="xs"
							title={`Delete ${template.filePath}`}
							variant="ghost">
							<Trash2 />
						</Button>
					)}
				</div>

				{confirming && (
					<div className="flex items-center gap-2 flex-wrap text-xs">
						<span className="text-foreground">
							Delete {sourceLabel(template.source).toLowerCase()} template <code>{template.fileName}</code>?{" "}
							{replacesBuiltin ? `The built-in ${template.name} applies again.` : "It cannot be undone."}
						</span>
						<Button
							aria-label={`Yes, delete ${template.fileName}`}
							disabled={deleting}
							onClick={() => void remove()}
							size="xs"
							variant="danger">
							{deleting ? "Deleting…" : "Yes"}
						</Button>
						<Button
							aria-label={`No, keep ${template.fileName}`}
							disabled={deleting}
							onClick={() => setConfirming(false)}
							size="xs"
							variant="ghost">
							No
						</Button>
					</div>
				)}

				{template.disabled && template.error === undefined && (
					<div className="text-xs text-description">
						Switched off for every session: the models it claims use the next template that claims them, or{" "}
						<code>default</code>.
					</div>
				)}

				{template.error !== undefined ? (
					<div className="flex items-start gap-1.5 text-xs text-error">
						<CircleAlert className="mt-0.5 shrink-0" />
						<span>
							{template.fileName}: {template.error}
						</span>
					</div>
				) : (
					<div className="text-xs text-description">
						<span>{template.match.join(" · ") || "any model"}</span>
						{template.hasSystem && <span> · system prompt</span>}
						<span> · {describeCoverage(template.tools, everyTool)}</span>
					</div>
				)}

				{template.warnings.map((warning) => (
					<div className="flex items-start gap-1.5 text-xs text-warning" key={warning}>
						<AlertTriangle className="mt-0.5 shrink-0" />
						<span>{warning}</span>
					</div>
				))}
			</div>
		)
	},
)

const PromptTemplatesSection = () => {
	const [state, setState] = useState<PromptTemplates | undefined>(undefined)
	const [error, setError] = useState<string | undefined>(undefined)
	const [loading, setLoading] = useState(true)
	const [generating, setGenerating] = useState(false)
	const [generated, setGenerated] = useState<string | undefined>(undefined)

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			setState(await FileServiceClient.getPromptTemplates(EmptyRequest.create({})))
			setError(undefined)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void refresh()
	}, [refresh])

	// `default.md` is the base layer and carries a section for every tool by
	// construction, so it is the list every other template is measured against.
	// Falling back to the union keeps the reading honest if it is ever missing.
	const everyTool = useMemo(() => {
		const base = state?.templates.find((template) => template.name === "default")
		if (base && base.tools.length > 0) {
			return base.tools
		}
		return [...new Set((state?.templates ?? []).flatMap((template) => template.tools))].sort()
	}, [state])

	const handleEdit = useCallback(
		async (template: PromptTemplateInfo) => {
			try {
				await FileServiceClient.openPromptTemplate(
					PromptTemplateEditRequest.create({
						fileName: template.fileName,
						filePath: template.filePath,
					}),
				)
				// Editing a built-in copies it to the global directory, so the list
				// it came from is already out of date by the time the file opens.
				await refresh()
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		},
		[refresh],
	)

	const handleDelete = useCallback(
		async (template: PromptTemplateInfo) => {
			let refusal: string | undefined
			try {
				await FileServiceClient.deletePromptTemplate(
					PromptTemplateEditRequest.create({
						fileName: template.fileName,
						filePath: template.filePath,
					}),
				)
			} catch (e) {
				refusal = e instanceof Error ? e.message : String(e)
			}
			// Either way the list may have moved: the file is gone, or it was
			// already gone and the row was stale. The reload clears the error
			// line when it succeeds, so a refusal is shown after it, not before.
			await refresh()
			if (refusal !== undefined) {
				setError(refusal)
			}
		},
		[refresh],
	)

	const handleToggle = useCallback(
		async (template: PromptTemplateInfo, enabled: boolean) => {
			let refusal: string | undefined
			try {
				await FileServiceClient.setPromptTemplateEnabled(
					PromptTemplateToggleRequest.create({ name: template.name, enabled }),
				)
			} catch (e) {
				refusal = e instanceof Error ? e.message : String(e)
			}
			// Which template is active may have moved, and every row of the same
			// name changes with it. As with a delete, the refusal is shown after
			// the reload, which clears the error line.
			await refresh()
			if (refusal !== undefined) {
				setError(refusal)
			}
		},
		[refresh],
	)

	const builtinNames = useMemo(
		() =>
			new Set(
				(state?.templates ?? []).filter((template) => template.source === "builtin").map((template) => template.name),
			),
		[state],
	)

	// Asks the selected model to write a template for itself. The point is the
	// model nobody has written one for — a freshly merged local build, a
	// provider we have never seen — where the alternative is the generic prompt
	// and no way to improve on it.
	const handleGenerate = useCallback(async () => {
		setGenerating(true)
		setGenerated(undefined)
		try {
			const result = await FileServiceClient.generatePromptTemplate(EmptyRequest.create({}))
			// Named, because these are the sections that can lose a session's
			// history: the user has to know they are in the file to review them.
			const compaction = [
				...(result.compactionKept.length > 0
					? [`It carries compaction prompts for ${result.compactionKept.join(", ")}: review them before relying on it.`]
					: []),
				...(result.compactionRemoved.length > 0
					? [
							`Removed failing compaction prompts for ${result.compactionRemoved.join(", ")}; those use the built-in prompt.`,
						]
					: []),
				...(result.compactionUnchanged.length > 0
					? [`The model left ${result.compactionUnchanged.join(", ")} unchanged; those keep using the built-in prompt.`]
					: []),
			].join(" ")
			setGenerated(
				(result.problems.length > 0
					? `Generated ${result.name} in ${result.attempts} attempt(s), but it still has problems: ${result.problems.join(" ")}`
					: `Generated ${result.name} in ${result.attempts} attempt(s). Edit it to review what the model proposed.`) +
					(compaction ? ` ${compaction}` : ""),
			)
			setError(undefined)
			await refresh()
			await FileServiceClient.openPromptTemplate(
				PromptTemplateEditRequest.create({ fileName: `${result.name}.md`, filePath: result.filePath }),
			)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setGenerating(false)
		}
	}, [refresh])

	return (
		<div>
			<div className="flex items-center gap-2 mb-3">
				<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider">Prompt Templates</div>
				<Button
					aria-label="Generate a template for the selected model"
					className="ml-auto"
					disabled={generating}
					onClick={handleGenerate}
					size="xs"
					variant="ghost">
					<Sparkles />
					{generating ? "Generating…" : "Generate"}
				</Button>
				<Button aria-label="Reload prompt templates" onClick={refresh} size="xs" variant="ghost">
					<RefreshCw />
					Reload
				</Button>
			</div>

			<div className="relative p-3 rounded-md border border-editor-widget-border/50">
				<p className="text-xs text-description mt-0 mb-3">
					The system prompt and tool descriptions a model receives. A template applies to a provider, a model family, or
					a model, and anything it leaves out falls back to <code>default.md</code>. Files in{" "}
					<code>{state?.globalDirectory ?? "the Cerebriline data directory"}</code>
					{state?.workspaceDirectory ? (
						<>
							{" "}
							and <code>{state.workspaceDirectory}</code>
						</>
					) : null}{" "}
					override the built-ins by name. Switch a template off and the models it claims fall back to the next one that
					claims them, in the end <code>default</code>. It applies from the next session, in the CLI and SDK too.
				</p>

				{generated !== undefined && <div className="text-xs text-success mb-3">{generated}</div>}

				{generating && (
					<div className="text-xs text-description mb-3">
						Asking the selected model to write a template for itself. It is checked and sent back for repair if
						anything is wrong, so this can take a few requests.
					</div>
				)}

				{error !== undefined && (
					<div className="flex items-start gap-1.5 text-xs text-error mb-3">
						<CircleAlert className="mt-0.5 shrink-0" />
						<span>{error}</span>
					</div>
				)}

				{state && !state.scopes?.length && (
					<div className="text-xs text-description mb-2">
						{state.modelId || "No model selected"}
						{state.family ? ` (${state.family})` : ""}
						{state.providerId ? ` on ${state.providerId}` : ""} →{" "}
						<span className="text-foreground">{state.activeName ?? "built-in prompt"}</span>
						{state.overlaid ? " over default" : ""}
					</div>
				)}

				{/* One row per model the task can actually run. The chat model was
				    the only one shown until now, which left the question this
				    panel exists to answer unanswerable for the subagent and for
				    the expert -- both usually a different model of a different
				    family, and the expert the one most likely to be reached
				    through a cloud tag, which reports no family and lands on the
				    base layer with nothing saying so. That case is called out
				    rather than left to be inferred from the name. */}
				{state && state.scopes?.length ? (
					<div className="mb-2 flex flex-col gap-0.5">
						{state.scopes.map((scope) => (
							<div className="text-xs text-description" key={`${scope.scope}:${scope.modelId}`}>
								<span className="text-foreground">{scope.scope}</span>
								{"  "}
								{scope.modelId || "no model"}
								{scope.family ? ` (${scope.family})` : ""}
								{scope.providerId ? ` on ${scope.providerId}` : ""} →{" "}
								<span className="text-foreground">{scope.templateName ?? "built-in prompt"}</span>
								{scope.overlaid ? " over default" : ""}
								{scope.fallback && <span className="text-warning"> — nothing claims this model</span>}
							</div>
						))}
					</div>
				) : null}

				{loading && state === undefined ? (
					<div className="text-xs text-description">Loading…</div>
				) : (
					state?.templates.map((template) => (
						<TemplateRow
							everyTool={everyTool}
							key={`${template.source}:${template.filePath ?? template.fileName}`}
							onDelete={handleDelete}
							onEdit={handleEdit}
							onToggle={handleToggle}
							replacesBuiltin={template.source !== "builtin" && builtinNames.has(template.name)}
							template={template}
						/>
					))
				)}
			</div>
		</div>
	)
}

export default memo(PromptTemplatesSection)
