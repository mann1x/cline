import { type FormEvent, useEffect, useRef, useState } from "react";
import type { DialogRequest } from "../shared/wire";

/**
 * The board backend's question, shown in the page: a list to pick from, a
 * text to type, or buttons. Escape or Cancel dismisses it (answer null).
 * `showModal` puts the focus on its first control: the first item, the text,
 * or Cancel.
 */
export function Dialog({
	request,
	onAnswer,
}: {
	request: DialogRequest;
	onAnswer: (answer: number | string | null) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [text, setText] = useState(
		request.kind === "input" ? (request.value ?? "") : "",
	);

	useEffect(() => {
		const element = dialog.current;
		if (element && !element.open) element.showModal();
	}, []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		onAnswer(text);
	};

	return (
		<dialog
			className="ask"
			onCancel={(event) => {
				event.preventDefault();
				onAnswer(null);
			}}
			ref={dialog}
		>
			{request.kind === "pick" && (
				<div className="ask-body">
					<p className="ask-title">{request.placeholder}</p>
					<ul className="ask-list">
						{request.items.map((item, index) => (
							<li key={`${index}-${item.label}`}>
								<button onClick={() => onAnswer(index)} type="button">
									<span className="ask-label">{item.label}</span>
									{item.description && (
										<span className="ask-description">{item.description}</span>
									)}
									{item.detail && (
										<span className="ask-detail">{item.detail}</span>
									)}
								</button>
							</li>
						))}
					</ul>
					<div className="ask-actions">
						<button onClick={() => onAnswer(null)} type="button">
							Cancel
						</button>
					</div>
				</div>
			)}
			{request.kind === "input" && (
				<form className="ask-body" onSubmit={submit}>
					{request.title && <p className="ask-title">{request.title}</p>}
					<label className="ask-prompt">
						{request.prompt}
						<input
							onChange={(event) => setText(event.target.value)}
							value={text}
						/>
					</label>
					{request.error && <p className="ask-error">{request.error}</p>}
					<div className="ask-actions">
						<button onClick={() => onAnswer(null)} type="button">
							Cancel
						</button>
						<button className="primary" type="submit">
							OK
						</button>
					</div>
				</form>
			)}
			{request.kind === "confirm" && (
				<div className="ask-body">
					<p className="ask-question">{request.question}</p>
					<div className="ask-actions">
						<button onClick={() => onAnswer(null)} type="button">
							Cancel
						</button>
						{request.buttons.map((button, index) => (
							<button
								className={index === 0 ? "primary" : undefined}
								key={button}
								onClick={() => onAnswer(button)}
								type="button"
							>
								{button}
							</button>
						))}
					</div>
				</div>
			)}
		</dialog>
	);
}
