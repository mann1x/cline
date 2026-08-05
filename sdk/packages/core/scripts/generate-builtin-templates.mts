/**
 * Regenerate `src/extensions/config/builtin-templates.generated.ts` from
 * `assets/prompt-templates/*.md`.
 *
 * Run after editing any shipped template:
 *   bun scripts/generate-builtin-templates.mts
 *
 * The logic lives in the source tree so the drift test can call exactly the
 * same function; this file only supplies the paths and writes the result.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBuiltinTemplatesModule } from "../src/extensions/config/builtin-templates-codegen";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(
	here,
	"..",
	"src",
	"extensions",
	"config",
	"builtin-templates.generated.ts",
);

writeFileSync(
	outputPath,
	buildBuiltinTemplatesModule(join(here, "..", "assets", "prompt-templates")),
	"utf8",
);
console.log(`wrote ${outputPath}`);
