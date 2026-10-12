---
name: media-images
description: >-
  Makes and changes pictures for the project: rendered screens and mockups of
  the application, workflow and architecture diagrams, charts, illustrations
  and photographs, icons in every format, and resized, cropped or converted
  copies of an image. Use when the user asks for an image, a picture of the
  interface, a diagram, a logo, an icon or favicon, images for a README or the
  documentation, or to change an image's size, shape or format.
---

# Images

You can make images yourself. Do not tell the user to make one elsewhere, and
do not describe an image you could produce.

## Which tool

| The picture is | Use | Why |
|---|---|---|
| A screen, a mockup, a dialog, anything showing the application's interface | `render_image` with HTML and CSS | Every label is the text you type. An image model garbles words |
| A workflow, a sequence, a state machine, an architecture, a schema | `render_image` with Mermaid | The notation is short and the layout is done for you |
| A chart, a badge, a banner with a title, an annotated figure | `render_image` with SVG or HTML | Exact numbers, exact text |
| A photograph, an illustration, a texture, a background, artwork | `generate_image` | Only an image model paints |
| An icon for an application, a site or a file type | `generate_icon` | Several proposals to choose from, then `.ico`, `.icns` and every PNG size |
| A change to a picture that exists (restyle, recolour, replace a part) | `edit_image` | It starts from the picture |
| The same picture at another size, cut down, or in another format | `transform_image` | Exact pixels, no redrawing |

The rule behind the table: **if it has words or structure in it, write it and
render it. If it is a picture of something, generate it.** Asked for "images
showing the workflow of the application", the right tool is `render_image`,
not `generate_image`.

`render_image` and `transform_image` need nothing set up. `generate_image`,
`generate_icon` and `edit_image` need an image endpoint; when you do not have
them, say that the user turns one on in **Settings > API Configuration >
Images**, and offer what `render_image` can do instead.

## Rendering a screen of the application

1. Read the component or template that draws the screen, and its stylesheet.
2. Write the screen as one HTML document: the application's own markup and
   class names, filled with realistic sample data. Link the project's real
   stylesheet with a relative URL (`<link rel="stylesheet"
   href="src/styles/app.css">`): relative URLs resolve from the workspace root.
   Inline what a build step would have produced.
3. Call `render_image` with `width` set to the window you want to show
   (1280 for a desktop, 390 for a phone) and no `height`: the picture is as
   tall as the page.
4. Look at the result if you can see images. Fix what is off and render again.

Do not invent an interface the application does not have. If you cannot read
the real one, say that the picture is a mockup.

## Diagrams

Write Mermaid. Keep node labels short; put detail in the surrounding text.

- A README shown on GitHub or GitLab renders a fenced `mermaid` block as it
  is. Prefer that there: it stays editable and needs no file.
- Render to a file with `render_image` when it must show somewhere that does
  not (npm, a PDF, a slide, the VS Code Marketplace) or must look the same
  everywhere. Save as `.svg` to keep it sharp at any size, `.png` otherwise.
- `theme: dark` for a dark page; `background: transparent` to sit on any page.

## Images for a README or the documentation

1. Decide what each image has to show before making any. One idea per image.
2. Save them in the repository where its other images are (`docs/images/`,
   `assets/`, `.github/`); create `docs/images/` when there is no such place.
   Give each a name that says what it shows.
3. Reference them with a relative path and alt text that says what is in the
   picture: `![The upload flow: validate, index, search](docs/images/upload-flow.png)`.
4. Keep them a sensible size: 1200 to 1600 pixels across is plenty for a
   README. Use `transform_image` to bring a larger one down.

## Icons

Call `generate_icon` with a `prompt`. It returns several numbered proposals.
Show them to the user and ask which one they want; the choice is theirs. Then
call it again with `pick` and `path`, and it writes the icon in every format.
Put the files where the project expects them (`public/favicon.ico`,
`build/icon.icns`, `assets/icon.png`) and update what refers to them: the
manifest, the HTML head, the packaging configuration.

An image the user already has becomes an icon the same way: pass it as `pick`.

## Size, shape and format

`transform_image` takes a `width` or a `height` (the other follows), both with
a `fit`, a `crop`, and writes whatever the `path` ends in: `.png`, `.jpg`,
`.webp`, `.ico`, `.icns`. Use it instead of a shell command. The source file
is never changed.

`render_image` also takes `width`, `height`, `scale` and `crop`, so a rendered
picture can be made at the right size in the first place.

## After making one

Say where the file is. If you cannot see images, say what you asked for and
let the user judge it. Generating costs time and may cost money: make one,
look, then decide whether another is needed.
