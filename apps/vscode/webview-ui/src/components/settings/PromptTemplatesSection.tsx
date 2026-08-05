import { EmptyRequest } from "@shared/proto/cline/common"
import { PromptTemplateEditRequest, type PromptTemplateInfo, type PromptTemplates } from "@shared/proto/cline/file"
import { AlertTriangle, CircleAlert, FilePenLine, RefreshCw, Sparkles } from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileServiceClient } from "@/services/grpc-client"

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

const TemplateRow = memo(
	({ template, onEdit }: { template: PromptTemplateInfo; onEdit: (template: PromptTemplateInfo) => void }) => {
		const dimmed = template.shadowed || template.error !== undefined

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
					{template.error !== undefined && <Badge variant="danger">Not loaded</Badge>}
					<Button
						aria-label={`Edit ${template.fileName}`}
						className="ml-auto"
						onClick={() => onEdit(template)}
						size="xs"
						variant="ghost">
						<FilePenLine />
						Edit
					</Button>
				</div>

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
						{template.tools.length > 0 && <span> · tools: {template.tools.join(", ")}</span>}
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

	// Asks the selected model to write a template for itself. The point is the
	// model nobody has written one for — a freshly merged local build, a
	// provider we have never seen — where the alternative is the generic prompt
	// and no way to improve on it.
	const handleGenerate = useCallback(async () => {
		setGenerating(true)
		setGenerated(undefined)
		try {
			const result = await FileServiceClient.generatePromptTemplate(EmptyRequest.create({}))
			setGenerated(
				result.problems.length > 0
					? `Generated ${result.name} in ${result.attempts} attempt(s), but it still has problems: ${result.problems.join(" ")}`
					: `Generated ${result.name} in ${result.attempts} attempt(s). Edit it to review what the model proposed.`,
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
					<code>{state?.globalDirectory ?? "the Cline data directory"}</code>
					{state?.workspaceDirectory ? (
						<>
							{" "}
							and <code>{state.workspaceDirectory}</code>
						</>
					) : null}{" "}
					override the built-ins by name.
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

				{state && (
					<div className="text-xs text-description mb-2">
						{state.modelId || "No model selected"}
						{state.family ? ` (${state.family})` : ""}
						{state.providerId ? ` on ${state.providerId}` : ""} →{" "}
						<span className="text-foreground">{state.activeName ?? "built-in prompt"}</span>
						{state.overlaid ? " over default" : ""}
					</div>
				)}

				{loading && state === undefined ? (
					<div className="text-xs text-description">Loading…</div>
				) : (
					state?.templates.map((template) => (
						<TemplateRow
							key={`${template.source}:${template.filePath ?? template.fileName}`}
							onEdit={handleEdit}
							template={template}
						/>
					))
				)}
			</div>
		</div>
	)
}

export default memo(PromptTemplatesSection)
