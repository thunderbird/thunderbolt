/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How to build and edit Word documents with `run_office_script`, loaded on demand as a skill. Every ```js block runs
 * in `office-script-skills.test.ts`.
 */
export const officeDocxSkill = `# Word documents with run_office_script

The \`docx\` global is the docx library, version 9. Build a \`docx.Document\` and save it once with \`saveFile(name, await docx.Packer.toArrayBuffer(doc))\`. \`Packer.toBuffer\` and \`Packer.toBlob\` do not work here.

## Example: a new document

Headings, formatted text, a bullet list, a table, a numbered list and page numbers.

\`\`\`js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Footer, AlignmentType, PageNumber, LevelFormat } = docx
const cell = (text, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] })
const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
  numbering: {
    config: [{ reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }] }],
  },
  sections: [{
    footers: {
      default: new Footer({
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })],
      }),
    },
    children: [
      new Paragraph({ text: "Quarterly report", heading: HeadingLevel.TITLE }),
      new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Revenue grew "), new TextRun({ text: "12%", bold: true }), new TextRun(" over the quarter.")] }),
      new Paragraph({ text: "Online sales doubled", bullet: { level: 0 } }),
      new Paragraph({ text: "Two new stores opened", bullet: { level: 0 } }),
      new Paragraph({ text: "Results by region", heading: HeadingLevel.HEADING_1 }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: [cell("Region", true), cell("Revenue", true)] }),
          new TableRow({ children: [cell("North"), cell("R$ 120.000")] }),
          new TableRow({ children: [cell("South"), cell("R$ 95.000")] }),
        ],
      }),
      new Paragraph({ text: "Next steps", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: "Hire two analysts", numbering: { reference: "steps", level: 0 } }),
      new Paragraph({ text: "Open the online store", numbering: { reference: "steps", level: 0 } }),
    ],
  }],
})
saveFile("report.docx", await Packer.toArrayBuffer(doc))
\`\`\`

## Building blocks

- Text: \`new Paragraph("plain")\`, or \`new Paragraph({ children: [new TextRun({ text, bold: true, italics: true, underline: {}, color: "C00000", size: 28 })] })\`. Sizes are half-points (28 is 14 pt), colors are hex without "#", and a run breaks its line with \`break: 1\`.
- Headings: \`heading: HeadingLevel.TITLE\` or \`HEADING_1\` to \`HEADING_6\`. Alignment: \`alignment: AlignmentType.CENTER\` (\`START\`, \`END\`, \`JUSTIFIED\`).
- Lists: \`bullet: { level: 0 }\` for bullets. A numbered list needs a \`numbering.config\` entry in the Document, as above, and \`numbering: { reference, level }\` on each paragraph.
- Tables: a \`TableCell\`'s children are paragraphs or tables, never strings. \`tableHeader: true\` repeats a row on each page; a cell takes \`shading: { fill: "D9E1F2" }\` and \`columnSpan\`.
- Pages: \`new Paragraph({ children: [new PageBreak()] })\` or \`pageBreakBefore: true\`. A section's \`properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }\` sets the page (1440 is one inch). \`headers: { default: new Header({ children }) }\` sits beside \`footers\`.
- Links: \`new ExternalHyperlink({ link: "https://example.com", children: [new TextRun({ text: "site", style: "Hyperlink" })] })\` inside a paragraph's children.
- Pictures: \`new ImageRun({ type, data, transformation: { width, height } })\` in a paragraph's children, with \`type\` "png", "jpg", "gif" or "bmp" and \`data\` the bytes. There is no network: read an attached picture with \`readFile\`, or take one from another file's \`word/media/\` with fflate.

\`\`\`js
const logo = new docx.ImageRun({ type: "png", data: readFile("logo.png"), transformation: { width: 160, height: 90 } })
const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph({ children: [logo] }), new docx.Paragraph("Our new logo")] }] })
saveFile("logo.docx", await docx.Packer.toArrayBuffer(doc))
\`\`\`

## Editing an attached document

List its exact name in \`inputs\`, change only what the user asked for, and save the result under the same name. Never rebuild it from its extracted text: that loses its styles, comments and tracked changes.

To fill a template, \`docx.patchDocument\` replaces \`{{key}}\` placeholders and keeps everything else, including comments and tracked changes. \`PatchType.PARAGRAPH\` puts runs where the placeholder was, inside its paragraph; \`PatchType.DOCUMENT\` replaces the whole paragraph with paragraphs or tables. \`keepOriginalStyles: true\`, the default, gives the new runs the placeholder's formatting, such as bold. Log the document's text first, as in the next example, to see which placeholders it has.

\`\`\`js
const { patchDocument, PatchType, Paragraph, TextRun } = docx
const name = "proposal.docx"
const bytes = await patchDocument({
  outputType: "uint8array",
  data: readFile(name),
  keepOriginalStyles: true,
  patches: {
    client: { type: PatchType.PARAGRAPH, children: [new TextRun("Acme Ltd")] },
    date: { type: PatchType.PARAGRAPH, children: [new TextRun("3 March 2027")] },
    scope: {
      type: PatchType.DOCUMENT,
      children: [new Paragraph("Two workshops in March."), new Paragraph("A written report in April.")],
    },
  },
})
saveFile(name, bytes)
\`\`\`

For any other change, such as editing text in place or adding a tracked change (\`w:ins\` and \`w:del\` with \`w:author\` and \`w:date\`), edit the XML. Unzip with \`fflate.unzipSync\`, parse the part with \`xmldom.DOMParser\`, change it, serialize it with \`xmldom.XMLSerializer\` and zip again with \`fflate.zipSync\`; \`fflate.strFromU8\` and \`fflate.strToU8\` convert the bytes. The body is \`word/document.xml\`. Word often splits one sentence across several runs (\`w:r\` holding \`w:t\`), so log each paragraph's text before you choose what to change. Write back only the parts you changed, and leave the others as they are, even when their XML declares an encoding such as windows-1252.

\`\`\`js
const name = "notes.docx"
const parts = fflate.unzipSync(readFile(name))
const path = "word/document.xml"
const doc = new xmldom.DOMParser().parseFromString(fflate.strFromU8(parts[path]), "application/xml")
const paragraphs = Array.from(doc.getElementsByTagName("w:p"))
const texts = (paragraph) => Array.from(paragraph.getElementsByTagName("w:t"))
console.log(JSON.stringify(paragraphs.map((paragraph) => texts(paragraph).map((t) => t.textContent).join(""))))
for (const t of texts(paragraphs[0])) {
  if (t.textContent === "paragraph!") t.textContent = "section!"
}
parts[path] = fflate.strToU8(new xmldom.XMLSerializer().serializeToString(doc))
saveFile(name, fflate.zipSync(parts))
\`\`\`

## Mistakes to avoid

- \`new TableCell({ children: ["text"] })\`: wrap text in \`new Paragraph("text")\`.
- \`italic: true\`: the option is \`italics\`.
- \`new ImageRun({ data })\` without \`type\`, or a URL for \`data\`: give the type and the bytes.
- \`Packer.toBuffer(doc)\` or \`Packer.toBlob(doc)\`: use \`await Packer.toArrayBuffer(doc)\`.
- \`console.log(value)\` prints [object Object]: log \`JSON.stringify(value)\`.`
