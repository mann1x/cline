import type { ViewerPipelineNode } from "@shared/board-viewer"
import { type KeyboardEvent, type ReactNode, useId, useState } from "react"
import {
	afterOptions,
	COMMON_FIELDS,
	type Completion,
	type ExpressionContext,
	expressionCompletions,
	GATE_SUGGESTIONS,
	STEP_FIELDS,
	STEP_HELP,
	type StepField,
} from "./step-form"

/** What the form completes from, beyond the step itself. */
export interface StepContext extends ExpressionContext {
	/** Every step of the pipeline, for `after`. */
	steps: readonly ViewerPipelineNode[]
	tools: readonly string[]
	agents: readonly string[]
	pipelines: readonly string[]
}

/** A label that explains itself on hover or focus. */
function Help({ label, help, required, htmlFor }: { label: string; help: string; required?: boolean; htmlFor?: string }) {
	return (
		<label className="bv-help" data-help={help} htmlFor={htmlFor} title={help}>
			{label}
			{required && <span aria-label="required"> *</span>}
		</label>
	)
}

/** A text field whose `{{ … }}` (or whole value, for a condition) completes names and functions at the caret. */
export function ExpressionInput({
	id,
	value,
	onChange,
	context,
	condition = false,
	multiline = false,
	placeholder,
	label,
}: {
	id: string
	value: string
	onChange: (value: string) => void
	context: ExpressionContext
	condition?: boolean
	multiline?: boolean
	placeholder?: string
	label: string
}) {
	const [caret, setCaret] = useState<number>()
	const [selected, setSelected] = useState(0)
	const [closed, setClosed] = useState(false)
	const offer = caret === undefined || closed ? undefined : expressionCompletions(value, caret, context, condition)
	const items = offer?.items ?? []
	const listId = `${id}-completions`
	const pick = (item: Completion) => {
		if (!offer || caret === undefined) return
		const next = value.slice(0, offer.from) + item.insert + value.slice(caret)
		onChange(next)
		setCaret(offer.from + item.insert.length)
		setSelected(0)
	}
	const track = (target: HTMLInputElement | HTMLTextAreaElement) => {
		setCaret(target.selectionStart ?? target.value.length)
		setClosed(false)
	}
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		if (items.length === 0) return
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault()
			setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length)
		} else if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault()
			pick(items[selected] ?? (items[0] as Completion))
		} else if (event.key === "Escape") {
			event.preventDefault()
			setClosed(true)
		}
	}
	const common = {
		"aria-activedescendant": items.length ? `${listId}-${selected}` : undefined,
		"aria-autocomplete": "list" as const,
		"aria-controls": items.length ? listId : undefined,
		"aria-expanded": items.length > 0,
		"aria-label": label,
		className: "bv-input bv-mono",
		id,
		onBlur: () => setTimeout(() => setCaret(undefined), 150),
		onChange: (event: { target: HTMLInputElement | HTMLTextAreaElement }) => {
			onChange(event.target.value)
			track(event.target)
		},
		onClick: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => track(event.currentTarget),
		onKeyDown,
		onKeyUp: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
				track(event.currentTarget)
		},
		placeholder,
		role: "combobox",
		spellCheck: false,
		value,
	}
	return (
		<div className="bv-complete">
			{multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
			{items.length > 0 && (
				<ul className="bv-complete-list" id={listId} role="listbox">
					{items.slice(0, 12).map((item, index) => (
						<li
							aria-selected={index === selected}
							id={`${listId}-${index}`}
							key={item.insert}
							onMouseDown={(event) => {
								event.preventDefault()
								pick(item)
							}}
							role="option"
							title={item.detail}>
							<span className="bv-mono">{item.label}</span>
							<span className="bv-muted">{item.detail}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/** A text input that offers values as the person types, each with what it means. */
function Suggest({
	id,
	value,
	onChange,
	options,
	placeholder,
	label,
}: {
	id: string
	value: string
	onChange: (value: string) => void
	options: readonly { value: string; label: string }[]
	placeholder?: string
	label: string
}) {
	return (
		<>
			<input
				aria-label={label}
				className="bv-input"
				id={id}
				list={`${id}-list`}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			<datalist id={`${id}-list`}>
				{options.map((option) => (
					<option key={option.value} label={option.label} value={option.value} />
				))}
			</datalist>
		</>
	)
}

type Values = Record<string, unknown>

function asText(value: unknown): string {
	return typeof value === "string" ? value : value === undefined ? "" : String(value)
}

/**
 * The form for one step: its type's fields, then the ones every step has.
 * Each label explains itself on hover; tools, agents, pipelines, gates and
 * the steps it runs after complete as typed, and `{{ … }}` completes names
 * and functions. Apply sends the step as JSON through the same check the
 * JSON tab uses.
 */
export function StepForm({
	node,
	context,
	onApply,
}: {
	node: ViewerPipelineNode
	context: StepContext
	onApply: (json: string) => string | undefined
}) {
	const base = useId()
	const [values, setValues] = useState<Values>(() => ({ ...node }))
	// JSON fields are edited as text and read at Apply.
	const [raw, setRaw] = useState<Record<string, string>>({})
	const [error, setError] = useState<string>()
	const type = String(node.type)
	const fields = [...(STEP_FIELDS[type] ?? []), ...COMMON_FIELDS]
	const set = (key: string, value: unknown) => {
		setError(undefined)
		setValues((current) => {
			const next = { ...current }
			if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key]
			else next[key] = value
			return next
		})
	}
	const apply = () => {
		const out: Values = { ...values }
		for (const [key, text] of Object.entries(raw)) {
			if (!text.trim()) {
				delete out[key]
				continue
			}
			try {
				out[key] = JSON.parse(text)
			} catch (failure) {
				// A swarm's tasks may be one expression, written as text.
				if (key === "tasks" && text.includes("{{")) {
					out[key] = text.trim()
					continue
				}
				setError(`${key}: not JSON (${failure instanceof Error ? failure.message : String(failure)})`)
				return
			}
		}
		const missing = fields.filter((field) => field.required && (out[field.key] === undefined || out[field.key] === ""))
		if (missing.length) {
			setError(`Fill in ${missing.map((field) => field.label).join(", ")}.`)
			return
		}
		setError(onApply(JSON.stringify(out)))
	}
	const control = (field: StepField, id: string): ReactNode => {
		const value = values[field.key]
		switch (field.kind) {
			case "expr":
			case "condition":
				return (
					<ExpressionInput
						condition={field.kind === "condition"}
						context={context}
						id={id}
						label={field.label}
						multiline={field.key === "command" || field.key === "task" || field.key === "message"}
						onChange={(next) => set(field.key, next)}
						placeholder={field.placeholder}
						value={asText(value)}
					/>
				)
			case "multiline":
				return (
					<textarea
						aria-label={field.label}
						className="bv-input bv-textarea"
						id={id}
						onChange={(event) => set(field.key, event.target.value)}
						rows={2}
						value={asText(value)}
					/>
				)
			case "number":
				return (
					<input
						aria-label={field.label}
						className="bv-input bv-input-short"
						id={id}
						min={0}
						onChange={(event) => set(field.key, event.target.value === "" ? undefined : Number(event.target.value))}
						type="number"
						value={typeof value === "number" ? value : ""}
					/>
				)
			case "boolean":
				return (
					<input
						aria-label={field.label}
						checked={value === true}
						id={id}
						onChange={(event) => set(field.key, event.target.checked || undefined)}
						type="checkbox"
					/>
				)
			case "enum":
				return (
					<select
						aria-label={field.label}
						className="bv-input"
						id={id}
						onChange={(event) => set(field.key, event.target.value || undefined)}
						value={asText(value)}>
						<option value="">(default)</option>
						{field.options?.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label === option.value ? option.value : `${option.value} — ${option.label}`}
							</option>
						))}
					</select>
				)
			case "json":
				return (
					<textarea
						aria-label={field.label}
						className="bv-input bv-textarea bv-mono"
						id={id}
						onChange={(event) => {
							setError(undefined)
							setRaw((current) => ({ ...current, [field.key]: event.target.value }))
						}}
						placeholder={field.placeholder}
						rows={3}
						spellCheck={false}
						value={raw[field.key] ?? (value === undefined ? "" : JSON.stringify(value, null, 2))}
					/>
				)
			case "list":
				return (
					<input
						aria-label={field.label}
						className="bv-input"
						id={id}
						onChange={(event) =>
							set(
								field.key,
								event.target.value
									.split(",")
									.map((word) => word.trim())
									.filter(Boolean),
							)
						}
						placeholder="ok, retry, give-up"
						value={Array.isArray(value) ? value.join(", ") : ""}
					/>
				)
			case "after":
				return (
					<AfterField
						id={id}
						onChange={(next) => set("after", next)}
						options={afterOptions(context.steps, node.id)}
						value={Array.isArray(value) ? value.map(String) : []}
					/>
				)
			case "tool":
			case "agent":
			case "pipeline":
			case "gate": {
				const options =
					field.kind === "tool"
						? context.tools.map((name) => ({ value: name, label: "a tool of this conversation" }))
						: field.kind === "agent"
							? context.agents.map((name) => ({ value: name, label: "a configured agent" }))
							: field.kind === "pipeline"
								? context.pipelines.map((name) => ({ value: name, label: "a pipeline of this workspace" }))
								: GATE_SUGGESTIONS
				return (
					<Suggest
						id={id}
						label={field.label}
						onChange={(next) => set(field.key, next)}
						options={options}
						placeholder={field.placeholder ?? (field.kind === "gate" ? "human:Go ahead?" : undefined)}
						value={asText(value)}
					/>
				)
			}
			default:
				return (
					<input
						aria-label={field.label}
						className="bv-input"
						id={id}
						onChange={(event) => set(field.key, event.target.value)}
						value={asText(value)}
					/>
				)
		}
	}
	return (
		<div className="bv-step-form">
			<div className="bv-note">
				<span className="bv-mono">{type}</span>: {STEP_HELP[type] ?? "A step of the pipeline."}
			</div>
			<div className="bv-field">
				<Help
					help="The step's id: what other steps name in after, and $node.<id> in an expression."
					htmlFor={`${base}-id`}
					label="Id"
					required
				/>
				<input
					aria-label="Id"
					className="bv-input bv-mono"
					id={`${base}-id`}
					onChange={(event) => set("id", event.target.value.trim())}
					value={asText(values.id)}
				/>
			</div>
			{fields.map((field) => {
				const id = `${base}-${field.key}`
				return (
					<div className={`bv-field${field.kind === "boolean" ? " bv-field-inline" : ""}`} key={field.key}>
						<Help help={field.help} htmlFor={id} label={field.label} required={field.required} />
						{control(field, id)}
					</div>
				)
			})}
			{error && <div className="bv-error">{error}</div>}
			<div className="bv-actions">
				<button className="bv-button bv-primary" onClick={apply} type="button">
					Apply
				</button>
			</div>
			<div className="bv-note">Changes go to the draft. Save it from the bar above the canvas.</div>
		</div>
	)
}

/** The steps a step runs after: each removable, more picked as typed. */
function AfterField({
	id,
	value,
	onChange,
	options,
}: {
	id: string
	value: string[]
	onChange: (next: string[]) => void
	options: { value: string; label: string }[]
}) {
	const [typed, setTyped] = useState("")
	const add = () => {
		const ref = typed.trim()
		if (!ref || value.includes(ref)) return
		onChange([...value, ref])
		setTyped("")
	}
	return (
		<div className="bv-after">
			{value.map((ref) => (
				<span className="bv-chip bv-chip-ref" key={ref}>
					<span className="bv-mono">{ref}</span>
					<button
						aria-label={`Not after ${ref}`}
						className="bv-chip-remove"
						onClick={() => onChange(value.filter((entry) => entry !== ref))}
						title="Remove"
						type="button">
						×
					</button>
				</span>
			))}
			<span className="bv-form">
				<Suggest
					id={id}
					label="Add a step it runs after"
					onChange={setTyped}
					options={options.filter((option) => !value.includes(option.value))}
					placeholder="build, or check.true"
					value={typed}
				/>
				<button className="bv-button" disabled={!typed.trim()} onClick={add} type="button">
					Add
				</button>
			</span>
		</div>
	)
}
