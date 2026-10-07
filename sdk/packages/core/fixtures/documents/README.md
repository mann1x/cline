# Document fixtures for `extract_document`

| File | Source | License |
|---|---|---|
| `probe.docx` | Written for these tests with python-docx: two headings, a table, a red 64×48 and a blue 40×40 PNG | Same as this repository |
| `probe.pdf`, `probe.epub`, `probe.mobi`, `probe.azw3`, `probe.fb2`, `probe.rtf` | `probe.docx` converted with calibre 8.6 `ebook-convert` | Same as this repository |
| `scan-only.pdf` | One page that is an image of text, no text layer | Same as this repository |
| `scan-stamped.pdf` | Two scanned pages with a real-text "Page N" stamp | Same as this repository |
| `scan-ccitt.pdf` | A 200 dpi bilevel page of four lines of text, CCITT G4 encoded (Pillow), no text layer | Same as this repository |
| `scan-ocrd.pdf` | Two scanned pages with an invisible (render mode 3) text layer | Same as this repository |
| `prefixed.epub` | Written for these tests: `container.xml`, OPF and NCX elements with namespace prefixes (`odfc:`, `opf:`, `ncx:`), an empty `<navMap/>` and `<guide/>`, a spine entry the manifest lacks, a single-quoted link to a stylesheet the book does not carry | Same as this repository |
| `op-test.pptx`, `op-encrypted.pdf` | [officeParser](https://github.com/harshankur/officeParser) test files | MIT |
| `two_images.doc`, `PngPicture.doc`, `SimpleWithImages.xls`, `pictures.ppt` | [Apache POI](https://github.com/apache/poi) `test-data/` | Apache-2.0 |
