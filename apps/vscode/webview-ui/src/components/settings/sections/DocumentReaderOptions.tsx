import { memo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { updateSetting } from "../utils/settingsHandlers"

/**
 * tesseract's codes for the languages most documents are in. Any other code
 * tesseract has a model for can be typed into the field below the list.
 */
export const OCR_LANGUAGES: readonly { code: string; name: string }[] = [
	{ code: "eng", name: "English" },
	{ code: "deu", name: "German" },
	{ code: "fra", name: "French" },
	{ code: "spa", name: "Spanish" },
	{ code: "ita", name: "Italian" },
	{ code: "por", name: "Portuguese" },
	{ code: "nld", name: "Dutch" },
	{ code: "pol", name: "Polish" },
	{ code: "ces", name: "Czech" },
	{ code: "slk", name: "Slovak" },
	{ code: "hun", name: "Hungarian" },
	{ code: "ron", name: "Romanian" },
	{ code: "swe", name: "Swedish" },
	{ code: "dan", name: "Danish" },
	{ code: "nor", name: "Norwegian" },
	{ code: "fin", name: "Finnish" },
	{ code: "ell", name: "Greek" },
	{ code: "tur", name: "Turkish" },
	{ code: "rus", name: "Russian" },
	{ code: "ukr", name: "Ukrainian" },
	{ code: "bul", name: "Bulgarian" },
	{ code: "srp", name: "Serbian" },
	{ code: "hrv", name: "Croatian" },
	{ code: "heb", name: "Hebrew" },
	{ code: "ara", name: "Arabic" },
	{ code: "fas", name: "Persian" },
	{ code: "hin", name: "Hindi" },
	{ code: "ben", name: "Bengali" },
	{ code: "tha", name: "Thai" },
	{ code: "vie", name: "Vietnamese" },
	{ code: "ind", name: "Indonesian" },
	{ code: "jpn", name: "Japanese" },
	{ code: "kor", name: "Korean" },
	{ code: "chi_sim", name: "Chinese (Simplified)" },
	{ code: "chi_tra", name: "Chinese (Traditional)" },
	{ code: "lat", name: "Latin" },
]

const LISTED = new Set(OCR_LANGUAGES.map((language) => language.code))

export function parseLanguageList(value: string | undefined): string[] {
	const codes = (value ?? "eng")
		.split(/[+,\s]+/)
		.map((code) => code.trim().toLowerCase())
		.filter(Boolean)
	return [...new Set(codes.length ? codes : ["eng"])]
}

interface DocumentReaderOptionsProps {
	ocr: string | undefined
	languages: string | undefined
	describeImages: boolean | undefined
}

/**
 * The Document Reader's own settings, shown under its switch once it is on.
 *
 * Languages are kept here as well as in the extension state: every toggle
 * sends the whole list, and building it from the state alone would read the
 * value from before the previous click until the host echoes it back.
 */
export const DocumentReaderOptions = memo(({ ocr, languages, describeImages }: DocumentReaderOptionsProps) => {
	const [selected, setSelected] = useState<string[]>(() => parseLanguageList(languages))
	const extra = selected.filter((code) => !LISTED.has(code))

	const save = (next: string[]) => {
		const list = [...new Set(["eng", ...next])]
		setSelected(list)
		updateSetting("extractDocumentOcrLanguages", list.join(","))
	}

	return (
		<div className="ml-3 pl-3 border-l border-editor-widget-border/50 space-y-3 pb-3">
			<div className="space-y-2">
				<Label className="text-sm font-medium text-foreground">Scanned pages</Label>
				<p className="text-xs text-muted-foreground">
					How the text of a scanned PDF page is read. Tesseract runs on this machine. Vision model uses the model on the
					Vision tab of the API settings, which reads handwriting and complex layouts better and costs a request per
					page; with no vision model, a session model that can see images reads the pages itself.
				</p>
				<Select onValueChange={(value) => updateSetting("extractDocumentOcr", value)} value={ocr ?? "tesseract"}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="tesseract">Tesseract (on this machine)</SelectItem>
						<SelectItem value="vision">Vision model</SelectItem>
						<SelectItem value="off">Off</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{(ocr ?? "tesseract") !== "off" && (
				<div className="space-y-2">
					<Label className="text-sm font-medium text-foreground">Recognition languages</Label>
					<p className="text-xs text-muted-foreground">
						The languages tesseract reads. English is included; each language you add is downloaded once (2 to 5 MB)
						into the Cerebriline data folder. Pick only the ones your documents use: every extra language makes
						recognition slower.
					</p>
					<div className="grid grid-cols-2 gap-x-3 gap-y-1">
						{OCR_LANGUAGES.map(({ code, name }) => (
							<label className="flex items-center gap-2 text-xs cursor-pointer" key={code}>
								<input
									checked={selected.includes(code)}
									disabled={code === "eng"}
									onChange={(event) =>
										save(
											event.target.checked
												? [...selected, code]
												: selected.filter((existing) => existing !== code),
										)
									}
									type="checkbox"
								/>
								{name}
							</label>
						))}
					</div>
					<Input
						defaultValue={extra.join(", ")}
						key={extra.join(",")}
						onBlur={(event) =>
							save([
								...selected.filter((code) => LISTED.has(code)),
								...parseLanguageList(event.target.value).filter((code) => code !== "eng"),
							])
						}
						placeholder="Other tesseract codes, e.g. grc, syr, deu_latf"
						type="text"
					/>
				</div>
			)}
			<div className="flex items-center justify-between w-full">
				<div className="text-sm">Describe pictures</div>
				<Switch
					checked={describeImages === true}
					className="shrink-0"
					id="extract-document-describe-images"
					onCheckedChange={(checked) => updateSetting("extractDocumentDescribeImages", checked)}
					size="lg"
				/>
			</div>
			<p className="text-xs text-muted-foreground">
				Have the vision model describe each picture the reader extracts, up to 16 per document. The description is stored
				in the pictures' index.json and used as their alt text. Needs a model on the Vision tab.
			</p>
		</div>
	)
})
