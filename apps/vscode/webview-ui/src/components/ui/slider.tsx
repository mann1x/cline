import * as SliderPrimitive from "@radix-ui/react-slider"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A single-thumb slider, themed off the VS Code palette.
 *
 * Kept to one thumb on purpose: the settings that want a slider here are
 * bounded quantities with one value, and a range control would imply the panel
 * can express two. `value` is passed as a one-element array by the callers so
 * the Radix contract stays visible rather than hidden behind a scalar prop.
 */
const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
	<SliderPrimitive.Root
		className={cn(
			"relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
			className,
		)}
		{...props}
		ref={ref}>
		<SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-[#8B8B8B]">
			<SliderPrimitive.Range className="absolute h-full bg-button-background/60" />
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			className="block h-3 w-3 rounded-full border border-(--vscode-panel-border) bg-button-foreground/80 shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background disabled:pointer-events-none"
			// Radix labels the thumb from the root's aria-label when one is
			// given; without it a keyboard user hears only "slider".
		/>
	</SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
